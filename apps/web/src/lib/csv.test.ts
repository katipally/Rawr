import assert from 'node:assert/strict'
import { test } from 'node:test'
import { csvReader, sniffDelimiter } from './csv.ts'

/** Every row of `text`, fed in pieces of `size` characters. */
const read = (text: string, size = text.length, delimiter = ','): string[][] => {
  const reader = csvReader(delimiter)
  const rows: string[][] = []
  for (let at = 0; at < text.length; at += size) rows.push(...reader.push(text.slice(at, at + size)))
  return [...rows, ...reader.end()]
}

const FILE = '\uFEFFName,Note,Deals\r\n"Smith, Jo","said ""hi""\nthen left",a;b\r\nLee,,\n'

test('quotes, doubled quotes, commas and line breaks inside quotes', () => {
  assert.deepEqual(read(FILE), [
    ['Name', 'Note', 'Deals'],
    ['Smith, Jo', 'said "hi"\nthen left', 'a;b'],
    ['Lee', '', ''],
  ])
})

test('the same rows whatever the file is cut into', () => {
  const whole = read(FILE)
  for (const size of [1, 2, 3, 5, 7, 11]) assert.deepEqual(read(FILE, size), whole, `pieces of ${size}`)
})

test('a last line with no line break is still a row', () => {
  assert.deepEqual(read('a,b\n1,2'), [
    ['a', 'b'],
    ['1', '2'],
  ])
})

test('a CR LF split across two pieces is one line ending, not an empty row', () => {
  const reader = csvReader()
  assert.deepEqual(reader.push('a,b\r'), [['a', 'b']])
  assert.deepEqual(reader.push('\n1,2\r\n'), [['1', '2']])
  assert.deepEqual(reader.end(), [])
})

test('the delimiter is read off the first line, outside quotes', () => {
  assert.equal(sniffDelimiter('Name,Email,Phone\n'), ',')
  assert.equal(sniffDelimiter('Name;Email;Phone\n'), ';')
  assert.equal(sniffDelimiter('Name\tEmail\tPhone\n'), '\t')
  assert.equal(sniffDelimiter('"Street, number";City;Zip\n'), ';')
  assert.equal(sniffDelimiter('Email\n'), ',')
})

test('a semicolon file reads with its own delimiter', () => {
  assert.deepEqual(read('a;b\n"x;y";z\n', 3, ';'), [
    ['a', 'b'],
    ['x;y', 'z'],
  ])
})
