import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
const cargo=process.env.CARGO || 'cargo';
execFileSync(cargo,['build','--locked','--release','--target','wasm32-unknown-unknown','--lib','-p','decision-rag-core'],{stdio:'inherit'});
mkdirSync('generated',{recursive:true});
copyFileSync('target/wasm32-unknown-unknown/release/decision_rag_core.wasm','generated/decision_core.wasm');
execFileSync(cargo,['build','--locked','--release','--target','wasm32-unknown-unknown','--lib','-p','decision-rag-worker'],{stdio:'inherit'});
execFileSync(process.env.WASM_BINDGEN || 'wasm-bindgen',['--target','web','--out-dir','generated/worker','--out-name','worker','target/wasm32-unknown-unknown/release/decision_rag_worker.wasm'],{stdio:'inherit'});
