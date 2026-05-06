import { geopolitical } from './geopolitical.js';
import { macro } from './macro.js';
import { cryptoRegulatory } from './cryptoRegulatory.js';
import { cryptoFutures } from './cryptoFutures.js';
import { aiTech } from './aiTech.js';
import { usPolitics } from './usPolitics.js';
import { sports } from './sports.js';

export const CATEGORIES = [geopolitical, macro, cryptoRegulatory, cryptoFutures, aiTech, usPolitics, sports] as const;

export { geopolitical, macro, cryptoRegulatory, cryptoFutures, aiTech, usPolitics, sports };
