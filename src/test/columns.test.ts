import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseColumns } from '../columns';

test('columns: coee stays where its pages are; code goes anywhere else', () => {
	assert.deepEqual(chooseColumns([], []), { coee: 2, code: 1 });          // nothing open
	assert.deepEqual(chooseColumns([], [1]), { coee: 2, code: 1 });         // code in 1: coee beside it
	assert.deepEqual(chooseColumns([2], [1, 3]), { coee: 2, code: 1 });     // pages in 2: reuse, never a third column
	assert.deepEqual(chooseColumns([1], [1, 2]), { coee: 1, code: 2 });     // pages moved to 1: code goes to the other side
	assert.deepEqual(chooseColumns([1], [1]), { coee: 1, code: 2 });        // the only editor shares coee's group: open code beside
	assert.deepEqual(chooseColumns([2], [3, 1]), { coee: 2, code: 3 });     // most recent code group wins
});
