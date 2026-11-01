#!/usr/bin/env node
/**
 * Tiny helper used during development: extract files from the packaged
 * DeepSeek Harness app.asar by path substring. Not needed at runtime.
 *
 *   node tools/extract-asar.mjs <asarPath> <outDir> <pathSubstring> [...]
 */
import fs from 'node:fs'
import path from 'node:path'

const [asarPath, outDir, ...wanted] = process.argv.slice(2)
if (!asarPath || !outDir || wanted.length === 0) {
  console.error('usage: node extract-asar.mjs <asarPath> <outDir> <pathSubstring> [...]')
  process.exit(2)
}

const fd = fs.openSync(asarPath, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const header = Buffer.alloc(headerSize)
fs.readSync(fd, header, 0, headerSize, 16)
const dataStart = 16 + headerSize
const tree = JSON.parse(header.toString('utf8'))

const files = []
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const full = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, full)
    else files.push({ path: full, offset: Number(entry.offset), size: entry.size, unpacked: entry.unpacked === true })
  }
}
walk(tree, '')

let extracted = 0
for (const file of files) {
  if (!wanted.some((needle) => file.path.includes(needle))) continue
  if (file.unpacked) continue
  const target = path.join(outDir, file.path)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const buf = Buffer.alloc(file.size)
  if (file.size > 0) fs.readSync(fd, buf, 0, file.size, dataStart + file.offset)
  fs.writeFileSync(target, buf)
  console.log(`extracted ${file.path} (${file.size} bytes) -> ${target}`)
  extracted += 1
}
console.log(`done: ${extracted} file(s) out of ${files.length} asar entries`)
