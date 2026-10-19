import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gistHistoryBudget } from '../lib/gist-budget.mjs'
test('keeps user retention preference when space allows', () => {
  assert.equal(gistHistoryBudget({ requested: 30, files: ['marker'], historyNames: [], newName: 'new', indexName: 'index' }), 30)
})
test('counts skills, sources and foreign files against shared budget', () => {
  assert.equal(gistHistoryBudget({ requested: 30, files: Array.from({length: 190}, (_, i) => String(i)), historyNames: [], newName: 'new', indexName: 'index' }), 8)
})
test('replaces old history rather than counting it as other-domain occupancy', () => {
  assert.equal(gistHistoryBudget({ requested: 30, files: Array.from({length: 200}, (_, i) => String(i)), historyNames: ['0','1','2','3','4'], newName: 'new', indexName: '4' }), 3)
})
test('no room fails closed without prescribing deletion', () => {
  assert.equal(gistHistoryBudget({ requested: 30, files: Array.from({length: 200}, (_, i) => String(i)), historyNames: [], newName: 'new', indexName: 'index' }), 0)
})
