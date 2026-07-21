/* register.mjs — node --import hook that activates loader.mjs. */
import { register } from 'node:module';
register(new URL('./loader.mjs', import.meta.url));
