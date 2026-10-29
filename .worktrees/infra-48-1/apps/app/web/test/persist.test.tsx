import { act, render, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { clearUnsent, readUnsent, UNSENT_PREFIX, usePersistentForm, writeUnsent } from '../src/persist';
import { RestoredNotice, SaveFailure } from '../src/ui';
import { ApiFailure } from '../src/api';

describe('unsent input', () => {
  it('mirrors every change into this tab’s storage and restores it after a reload', () => {
    const first = renderHook(() => usePersistentForm('form:a', { title: '', count: 0 }));
    expect(first.result.current.restored).toBe(false);
    act(() => first.result.current.set('title', 'Draft title'));
    expect(JSON.parse(sessionStorage.getItem(`${UNSENT_PREFIX}form:a`)!)).toEqual({ title: 'Draft title', count: 0 });
    first.unmount();
    const reloaded = renderHook(() => usePersistentForm('form:a', { title: '', count: 0 }));
    expect(reloaded.result.current.values).toEqual({ title: 'Draft title', count: 0 });
    expect(reloaded.result.current.restored).toBe(true);
  });

  it('keeps the input until it is sent, then forgets it but keeps what the page shows', () => {
    const form = renderHook(() => usePersistentForm('form:b', { title: '' }));
    act(() => form.result.current.replace({ title: 'Sent title' }));
    act(() => form.result.current.sent());
    expect(sessionStorage.getItem(`${UNSENT_PREFIX}form:b`)).toBeNull();
    expect(form.result.current.values).toEqual({ title: 'Sent title' });
  });

  it('discards the input and returns to the initial values', () => {
    writeUnsent('form:c', { title: 'Old' });
    const form = renderHook(() => usePersistentForm('form:c', () => ({ title: 'Initial' })));
    expect(form.result.current.restored).toBe(true);
    act(() => form.result.current.discard());
    expect(form.result.current.values).toEqual({ title: 'Initial' });
    expect(form.result.current.restored).toBe(false);
    expect(readUnsent('form:c')).toBeUndefined();
  });

  it('fills fields added since the input was stored from the initial values and ignores unreadable entries', () => {
    writeUnsent('form:d', { title: 'Kept' });
    const form = renderHook(() => usePersistentForm('form:d', { title: '', note: 'initial note' }));
    expect(form.result.current.values).toEqual({ title: 'Kept', note: 'initial note' });
    sessionStorage.setItem(`${UNSENT_PREFIX}form:e`, '{not json');
    expect(readUnsent('form:e')).toBeUndefined();
    clearUnsent('form:d');
    expect(readUnsent('form:d')).toBeUndefined();
  });

  it('tells the Member after a failure that the input was not saved and after a reload that it was restored', () => {
    const view = render(<><SaveFailure error={new ApiFailure(0, 'network')} /><RestoredNotice onDiscard={() => undefined} /></>);
    expect(view.getAllByRole('alert')).toHaveLength(2);
    expect(view.container.textContent).toContain('Your input was not saved; it is kept in this tab.');
    expect(view.container.textContent).toContain('Your unsent input was restored. It has not been saved.');
  });
});
