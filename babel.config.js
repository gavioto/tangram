module.exports = function(context) {
  const env = context.cache(() => process.env.BABEL_ENV);

  const targets = env === 'esmodules' ?
    { esmodules: true } :
    { browsers: ['last 2 versions', 'ie >= 11', 'safari >= 7'] };

  return {
    presets: [
      [
        '@babel/preset-env', {
          targets,
          loose: true,
          debug: true,
          useBuiltIns: env === 'esmodules' ? false : 'usage',
          // include: [
          //   'es6.promise',
          //   'es6.object.assign',
          //   'es6.math.hypot',
          //   'es6.math.log2',
          //   'web.dom.iterable'
          // ]
        }
      ],
    ]
  };
};
