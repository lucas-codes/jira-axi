import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/dist/index.js')) throw new Error('DUMMY_SECRET \u009b \x1b[31m');
    return nextResolve(specifier, context);
  },
});
