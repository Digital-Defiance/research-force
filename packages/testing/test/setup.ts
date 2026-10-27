import { inject } from 'vitest';
import { configurePropertyTests } from '../src/fc';

configurePropertyTests(inject('fcRuns'));
