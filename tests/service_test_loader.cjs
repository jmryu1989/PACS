'use strict';
// Source-only behavioral suites use the installed TypeScript compiler, never a text extractor.
// The same CJS cases also run unchanged against /app/dist in the API image.
const Module = require('node:module'), path = require('node:path'), fs = require('node:fs');
const root = path.resolve(__dirname, '..'), api = path.join(root, 'api');
const ts = require(path.join(api, 'node_modules/typescript'));
const source = process.env.KIN_TEST_API_SRC || path.join(api, 'src');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, parent, ...rest) {
  if (name.startsWith('/app/dist/')) name = path.join(source, name.slice(10).replace(/\.js$/, '') + '.ts');
  else if (name.startsWith('/app/node_modules/')) name = path.join(api, 'node_modules', name.slice(18));
  return resolve.call(this, name, parent, ...rest);
};
require.extensions['.ts'] = (module, file) => {
  module.paths.push(path.join(api, 'node_modules'));
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true,
    emitDecoratorMetadata: true, esModuleInterop: true,
  } });
  module._compile(compiled.outputText, file);
};
