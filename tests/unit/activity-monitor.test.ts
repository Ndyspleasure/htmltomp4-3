// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { isRealChange } from '../../src/sandbox/activity-monitor';

const text = (value: string) => document.createTextNode(value);
const nodeList = (nodes: Node[]) => nodes as unknown as NodeList;

function record(partial: Partial<MutationRecord>): MutationRecord {
  return {
    addedNodes: nodeList([]),
    removedNodes: nodeList([]),
    oldValue: null,
    attributeName: null,
    attributeNamespace: null,
    ...partial,
  } as MutationRecord;
}

describe('isRealChange', () => {
  it('ignores textContent rewrites with identical text', () => {
    expect(
      isRealChange(
        record({ type: 'childList', removedNodes: nodeList([text('0:06')]), addedNodes: nodeList([text('0:06')]) }),
      ),
    ).toBe(false);
    expect(
      isRealChange(
        record({ type: 'childList', removedNodes: nodeList([text('0:05')]), addedNodes: nodeList([text('0:06')]) }),
      ),
    ).toBe(true);
  });

  it('ignores attribute writes that keep the same value', () => {
    const el = document.createElement('div');
    el.setAttribute('style', 'width: 50%;');
    expect(
      isRealChange(record({ type: 'attributes', target: el, attributeName: 'style', oldValue: 'width: 50%;' })),
    ).toBe(false);
    expect(
      isRealChange(record({ type: 'attributes', target: el, attributeName: 'style', oldValue: 'width: 40%;' })),
    ).toBe(true);
  });

  it('treats element insertions as real changes', () => {
    expect(isRealChange(record({ type: 'childList', addedNodes: nodeList([document.createElement('p')]) }))).toBe(true);
  });

  it('compares character data with its old value', () => {
    const node = text('a');
    expect(isRealChange(record({ type: 'characterData', target: node, oldValue: 'a' }))).toBe(false);
    expect(isRealChange(record({ type: 'characterData', target: node, oldValue: 'b' }))).toBe(true);
  });
});
