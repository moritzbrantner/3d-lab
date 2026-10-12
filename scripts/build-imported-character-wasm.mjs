import {spawnSync} from "node:child_process"
import {mkdirSync} from "node:fs"
function run(command, args) {
  const result = spawnSync(command, args, {stdio:"inherit"})
  if (result.status !== 0) throw new Error(`${command} failed`)
}
run("rustup", ["target", "add", "wasm32-unknown-unknown"])
const version = spawnSync("wasm-bindgen", ["--version"], {encoding:"utf8"})
if (version.status !== 0 || version.stdout.trim() !== "wasm-bindgen 0.2.129") {
  run("cargo", ["install", "wasm-bindgen-cli", "--version", "0.2.129", "--locked"])
}
run("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "three-d-character-wasm"])
mkdirSync("packages/renderer/imported-character-wasm", {recursive:true})
run("wasm-bindgen", ["target/wasm32-unknown-unknown/release/three_d_character_wasm.wasm", "--target", "web", "--out-dir", "packages/renderer/imported-character-wasm", "--out-name", "character"])
