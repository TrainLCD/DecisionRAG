import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
execFileSync(process.env.CARGO || 'cargo', ['build','--locked','--release','--target','wasm32-unknown-unknown','--lib'], {stdio:'inherit'});
mkdirSync('generated', {recursive:true});
copyFileSync('target/wasm32-unknown-unknown/release/decision_rag_core.wasm','generated/decision_core.wasm');
