// Копирует тестовое хранилище в .cache/demo-store, чтобы студию можно было попробовать, ничего не испортив.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/core/store.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dst = path.join(root, '.cache', 'demo-store');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(path.join(root, 'examples', 'store'), dst, { recursive: true });
Store.init(dst, { git: false });
console.log(`Тестовое хранилище: ${dst}\nЗапуск студии: npm run demo:studio`);
