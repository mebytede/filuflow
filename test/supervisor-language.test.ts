// Language of the supervisor (M39): setting for analyses and reports, the editor chat follows the interface language
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/supervisor/settings.js';
import { SYSTEM_PROMPT, systemPrompt } from '../src/supervisor/supervisor.js';

describe('supervisor language', () => {
  it('defaults to English and accepts only en and de', () => {
    expect(DEFAULT_SETTINGS.language).toBe('en');
    expect(normalizeSettings({ language: 'de' })).toMatchObject({ language: 'de' });
    expect(normalizeSettings({ language: 'fr' })).toBe('language must be "en" or "de"');
    expect(normalizeSettings({}, { ...DEFAULT_SETTINGS, language: 'de' })).toMatchObject({ language: 'de' });
  });

  it('asks the model to answer in the chosen language', () => {
    expect(SYSTEM_PROMPT).toContain('Answer in English.');
    expect(systemPrompt('de')).toContain('Answer in German and address the person formally ("Sie").');
    expect(systemPrompt('de')).not.toContain('Answer in English.');
  });
});
