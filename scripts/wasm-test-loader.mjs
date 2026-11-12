import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
// Production imports a Wasm module via Wrangler. Node tests load exactly the
// same compiled bytes, rather than substituting a JavaScript implementation.
export async function resolve(specifier, context, next) {
  const generated = pathToFileURL(process.cwd()+'/dist-test/generated/').href;
  const resolved = context.parentURL && specifier.startsWith('.') ? new URL(specifier, context.parentURL).href : '';
  if (resolved.startsWith(generated)) return {url:pathToFileURL(process.cwd()+'/generated/'+resolved.slice(generated.length)).href,shortCircuit:true};
  return next(specifier,context);
}
export async function load(url,context,next) {
  if (url.endsWith('.wasm')) {
    const bytes=await readFile(new URL(url));
    return {format:'module',shortCircuit:true,source:`export default new WebAssembly.Module(Uint8Array.from(Buffer.from('${bytes.toString('base64')}','base64')));`};
  }
  return next(url,context);
}
