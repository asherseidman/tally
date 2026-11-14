import { execFileSync } from 'node:child_process';
import { seedDemo } from './seed';

seedDemo();
console.log('\n--- demo database contents ---\n');
execFileSync('npx', ['tsx', 'src/cli/show.ts', '--demo'], { stdio: 'inherit' });
console.log('\nTry a review against the demo DB (never touches real data):');
console.log('  npm run import -- samples/math-101.json --demo');
console.log('  npm run import -- samples/math-101-revised.json --demo   # shows changed / missing');
