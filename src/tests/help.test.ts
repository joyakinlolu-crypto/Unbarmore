import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x',
  });
});

import { HELP_TOPICS, matchHelpTopic, parseHelpCommand, topicById } from '../lib/help.js';
import { helpPicker } from '../flows/help.js';

describe('help topics', () => {
  it('fit a WhatsApp list row: title up to 24 characters, description up to 72', () => {
    for (const t of HELP_TOPICS) {
      expect(t.title.length).toBeLessThanOrEqual(24);
      expect(t.description.length).toBeLessThanOrEqual(72);
      expect(t.steps.join('\n').length).toBeLessThan(1500);
    }
  });
  it('are 9 topics, so the picker has 9 problems plus "Talk to a person" (10 rows max)', () => expect(HELP_TOPICS).toHaveLength(9));
  it('each topic id is unique', () => expect(new Set(HELP_TOPICS.map((t) => t.id)).size).toBe(HELP_TOPICS.length));
  it('only teach commands that exist', () => {
    const text = HELP_TOPICS.flatMap((t) => t.steps).join(' ');
    for (const c of ['UNDO', 'CHASE', 'BUY VIDEOS', 'MAKE LOGO', 'INVOICES', 'RECEIPT', 'PLANS', 'DASHBOARD', 'REMINDERS OFF', 'DELETE MY DATA', 'MY ACCOUNT', 'MY ADDRESS']) expect(text).toContain(c);
  });
});

describe('HELP command', () => {
  it('HELP opens the picker; HELP plus words carries the words', () => {
    expect(parseHelpCommand('HELP')).toEqual({ text: '' });
    expect(parseHelpCommand('help')).toEqual({ text: '' });
    expect(parseHelpCommand('HELP my video did not come')).toEqual({ text: 'my video did not come' });
  });
  it('does not steal a sale that starts with "help"', () => {
    expect(parseHelpCommand('help me record sold 3 lace 30k')).toBeNull();
    expect(parseHelpCommand('help I sold 25000 today')).toBeNull();
  });
  it('ignores words that only start with help', () => {
    expect(parseHelpCommand('helpful tips')).toBeNull();
    expect(parseHelpCommand('MENU')).toBeNull();
  });
  it('finds the right topic from plain words', () => {
    expect(matchHelpTopic('my video did not come')?.id).toBe('video');
    expect(matchHelpTopic('my profit looks wrong')?.id).toBe('profit');
    expect(matchHelpTopic('I paid but my plan did not change')?.id).toBe('plan');
    expect(matchHelpTopic('dashboard link expired')?.id).toBe('app');
    expect(matchHelpTopic('how do I make a flyer with my logo')?.id).toBe('flyer');
  });
  it('returns null when nothing fits, so a person sees it', () => expect(matchHelpTopic('zzz qqq')).toBeNull());
  it('looks a topic up by id', () => { expect(topicById('debt')?.title).toMatch(/Debts/); expect(topicById('nope')).toBeUndefined(); });
});

describe('help picker', () => {
  it('shows 9 problems plus "Talk to a person"', () => {
    const p = JSON.stringify(helpPicker('2349000000401'));
    for (const t of HELP_TOPICS) expect(p).toContain(`HELP:${t.id}`);
    expect(p).toContain('HELP:person');
  });
});
