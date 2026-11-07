import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

// `npm run test:full`: the normal suite plus the full benchmarks checked against results/published/.
export default mergeConfig(base, defineConfig({ test: { env: { FLEXIPATH_FULL: '1' } } }));
