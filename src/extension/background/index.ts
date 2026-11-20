/**
 * Service worker entry point.
 *
 * Two responsibilities, kept in separate modules:
 *  - install lifecycle: the per-install seed and its synchronous delivery
 *    channel (background/install.ts);
 *  - wire-level header coherence: UA / Client Hints / Accept-Language must
 *    match the profile the page reports (background/headers.ts).
 */

import { registerInstallLifecycle } from './install.js';
import { registerHeaderRules } from './headers.js';

registerInstallLifecycle();
registerHeaderRules();
