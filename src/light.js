/*global Light */
import ShaderProgram from './gl/shader_program';
import shaderSources from './gl/shader_sources'; // built-in shaders
import GLSL from './gl/glsl';
import Geo from './geo';
import {StyleParser} from './styles/style_parser';

// Abstract light
export default class Light {

    constructor (scene, config) {
        this.name = config.name;
        this.scene = scene;

        this.ambient = GLSL.expandVec4(config.ambient || 0);
        this.diffuse = GLSL.expandVec4(config.diffuse != null ? config.diffuse : 1);
        this.specular = GLSL.expandVec4(config.specular || 0);
    }

    // Create a light by type name, factory-style
    // 'config' must include 'name' and 'type', along with any other type-specific properties
    static create (scene, config) {
        if (Light.types[config.type]) {
            return new Light.types[config.type](scene, config);
        }
    }

    // Set light for a style: fragment lighting, vertex lighting, or none
    static setMode (mode, style) {
        mode = Light.enabled && ((mode != null) ? mode : 'fragment'); // default to fragment lighting
        style.defines['TANGRAM_LIGHTING_FRAGMENT'] = (mode === 'fragment');
        style.defines['TANGRAM_LIGHTING_VERTEX'] = (mode === 'vertex');
    }

    // Inject all provided light definitions, and calculate cumulative light function
    static inject (lights) {
        // Clear previous injections
        ShaderProgram.removeTransform(Light.transform);

        // If lighting is globally disabled, nothing is injected (mostly for debugging or live editing)
        if (!Light.enabled) {
            return;
        }

        // Construct code to calculate each light instance
        let calculateLights = "";
        if (lights && Object.keys(lights).length > 0) {
            // Collect uniques types of lights
            let types = {};
            for (let light_name in lights) {
                types[lights[light_name].type] = true;
            }

            // Inject each type of light
            for (let type in types) {
                Light.types[type].inject();
            }

            // Inject per-instance blocks and construct the list of functions to calculate each light
            for (let light_name in lights) {
                // Define instance
                lights[light_name].inject();

                // Add the calculation function to the list
                calculateLights += `calculateLight(g_${light_name}, _eyeToPoint, _normal);\n`;
            }
        }
        else {
            // If no light is defined, use 100% omnidirectional diffuse light
            calculateLights = `
                #ifdef TANGRAM_MATERIAL_DIFFUSE
                    g_light_accumulator_diffuse = vec4(1.);
                #endif
            `;
        }

        // Glue together the final lighting function that sums all the lights
        let calculateFunction = `
            vec4 calculateLighting(in vec3 _eyeToPoint, in vec3 _normal, in vec4 _color) {

                ${calculateLights}

                //  Final light intensity calculation
                vec4 color = vec4(0.0);

                #ifdef TANGRAM_MATERIAL_EMISSION
                    color = g_material.emission;
                #endif

                #ifdef TANGRAM_MATERIAL_AMBIENT
                    color += g_light_accumulator_ambient * _color * g_material.ambient;
                #endif

                #ifdef TANGRAM_MATERIAL_DIFFUSE
                    color += g_light_accumulator_diffuse * _color * g_material.diffuse;
                #endif

                #ifdef TANGRAM_MATERIAL_SPECULAR
                    color += g_light_accumulator_specular * g_material.specular;
                #endif

                // Clamp final color
                color = clamp(color, 0.0, 1.0);

                return color;
            }`;

        ShaderProgram.addTransform(Light.transform, calculateFunction);
    }

    // Common instance definition
    inject () {
        let instance =  `
            uniform ${this.struct_name} u_${this.name};
            ${this.struct_name} g_${this.name} = u_${this.name};\n`;

        ShaderProgram.addTransform(Light.transform, instance);
    }

    // Update method called once per frame
    update () {
    }

    // Called once per frame per program (e.g. for main render pass, then for each additional
    // pass for feature selection, etc.)
    setupProgram (_program) {
        //  Three common light properties
        _program.uniform('4fv', `u_${this.name}.ambient`, this.ambient);
        _program.uniform('4fv', `u_${this.name}.diffuse`, this.diffuse);
        _program.uniform('4fv', `u_${this.name}.specular`, this.specular);
    }

}

Light.types = {}; // references to subclasses by short name
Light.transform = 'lighting'; // shader transform name
Light.enabled = true; // lighting can be globally enabled/disabled


// Light subclasses
class AmbientLight extends Light {

    constructor(scene, config) {
        super(scene, config);
        this.type = 'ambient';
        this.struct_name = 'AmbientLight';
    }

    // Inject struct and calculate function
    static inject() {
        ShaderProgram.addTransform(Light.transform, shaderSources['gl/shaders/ambientLight']);
    }

    setupProgram (_program) {
        _program.uniform('4fv', `u_${this.name}.ambient`, this.ambient);
    }

}
Light.types['ambient'] = AmbientLight;

class DirectionalLight extends Light {

    constructor(scene, config) {
        super(scene, config);
        this.type = 'directional';
        this.struct_name = 'DirectionalLight';

        this.direction = (config.direction || [0.2, 0.7, -0.5]).map(parseFloat); // [x, y, z]
    }

    // Inject struct and calculate function
    static inject() {
        ShaderProgram.addTransform(Light.transform, shaderSources['gl/shaders/directionalLight']);
    }

    setupProgram (_program) {
        super.setupProgram(_program);
        _program.uniform('3fv', `u_${this.name}.direction`, this.direction);
    }

}
Light.types['directional'] = DirectionalLight;


class PointLight extends Light {

    constructor (scene, config) {
        super(scene, config);
        this.type = 'point';
        this.struct_name = 'PointLight';

        this.position = config.position || [0, 0, 0];
        this.position_eye = []; // position in eyespace
        this.origin = config.origin || 'world';
        this.attenuation = !isNaN(parseFloat(config.attenuation)) ? parseFloat(config.attenuation) : 0;
        this.inner_radius = config.inner_radius || 0;
        this.outer_radius = config.outer_radius || 0;
    }

    // Inject struct and calculate function
    static inject () {
        ShaderProgram.addTransform(Light.transform, shaderSources['gl/shaders/pointLight']);
    }

    // Inject isntance-specific settings
    inject() {
        super.inject();

        ShaderProgram.defines['TANGRAM_POINTLIGHT_ATTENUATION_EXPONENT'] = (this.attenuation !== 0);
        ShaderProgram.defines['TANGRAM_POINTLIGHT_ATTENUATION_INNER_RADIUS'] = (this.inner_radius !== 0);
        ShaderProgram.defines['TANGRAM_POINTLIGHT_ATTENUATION_OUTER_RADIUS'] = ((this.outer_radius !== 0) && (this.outer_radius >= this.inner_radius));
    }

    update () {
        this.updateEyePosition();
    }

    updateEyePosition () {
        if (this.origin === 'world') {
            // For world origin, format is: [longitude, latitude, meters (default) or pixels w/px units]

            // Move light's world position into camera space
            let [x, y] = Geo.latLngToMeters(this.position);
            this.position_eye[0] = x - this.scene.camera.position_meters[0];
            this.position_eye[1] = y - this.scene.camera.position_meters[1];

            this.position_eye[2] = StyleParser.convertUnits(this.position[2], { zoom: this.scene.zoom });
            this.position_eye[2] = this.position_eye[2] - this.scene.camera.position_meters[2];
        }
        if (this.origin === 'ground' || this.origin === 'camera') {
            // For camera or ground origin, format is: [x, y, z] in meters (default) or pixels w/px units

            // Light is in camera space by default
            this.position_eye = StyleParser.convertUnits(this.position, { zoom: this.scene.zoom });

            if (this.origin === 'ground') {
                // Leave light's xy in camera space, but z needs to be moved relative to ground plane
                this.position_eye[2] = this.position_eye[2] - this.scene.camera.position_meters[2];
            }
        }
    }

    setupProgram (_program) {
        super.setupProgram(_program);

        _program.uniform('4f', `u_${this.name}.position`,
            this.position_eye[0], this.position_eye[1], this.position_eye[2], 1);

        if(ShaderProgram.defines['TANGRAM_POINTLIGHT_ATTENUATION_EXPONENT']) {
            _program.uniform('1f', `u_${this.name}.attenuationExponent`, this.attenuation);
        }

        if(ShaderProgram.defines['TANGRAM_POINTLIGHT_ATTENUATION_INNER_RADIUS']) {
            _program.uniform('1f', `u_${this.name}.innerRadius`,
                StyleParser.convertUnits(this.inner_radius, { zoom: this.scene.zoom }));
        }

        if(ShaderProgram.defines['TANGRAM_POINTLIGHT_ATTENUATION_OUTER_RADIUS']) {
            _program.uniform('1f', `u_${this.name}.outerRadius`,
                StyleParser.convertUnits(this.outer_radius, { zoom: this.scene.zoom }));
        }
    }
}
Light.types['point'] = PointLight;


class SpotLight extends PointLight {

    constructor (scene, config) {
        super(scene, config);
        this.type = 'spotlight';
        this.struct_name = 'SpotLight';

        this.direction = (config.direction || [0, 0, -1]).map(parseFloat); // [x, y, z]
        this.exponent = config.exponent ? parseFloat(config.exponent) : 0.2;
        this.angle = config.angle ? parseFloat(config.angle) : 20;
    }

    // Inject struct and calculate function
    static inject () {
        ShaderProgram.addTransform(Light.transform, shaderSources['gl/shaders/spotLight']);
    }

    setupProgram (_program) {
        super.setupProgram(_program);

        _program.uniform('3fv', `u_${this.name}.direction`, this.direction);
        _program.uniform('1f', `u_${this.name}.spotCosCutoff`, Math.cos(this.angle * 3.14159 / 180));
        _program.uniform('1f', `u_${this.name}.spotExponent`, this.exponent);
    }

}
Light.types['spotlight'] = SpotLight;
