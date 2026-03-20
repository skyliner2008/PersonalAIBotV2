import { implementProposalById } from './src/evolution/selfUpgrade.js';
import path from 'path';

console.log("Starting manual test for proposal 74...");
implementProposalById(74, path.resolve(process.cwd(), 'src'))
  .then(res => { console.log('Result:', res); process.exit(0); })
  .catch(err => { console.error('Error:', err.message); process.exit(1); });
