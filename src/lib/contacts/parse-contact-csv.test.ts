import { describe, expect, it } from 'vitest';
import { parseContactCsv, parseTagCell } from './parse-contact-csv';

describe('parseTagCell', () => {
  it('splits comma-separated tags and trims whitespace', () => {
    expect(parseTagCell(' VIP , Lead ,  ')).toEqual(['VIP', 'Lead']);
  });

  it('splits semicolon-separated tags', () => {
    expect(parseTagCell('VIP; Lead; Customer')).toEqual([
      'VIP',
      'Lead',
      'Customer',
    ]);
  });

  it('de-dupes case-insensitively', () => {
    expect(parseTagCell('vip, VIP, Lead')).toEqual(['vip', 'Lead']);
  });

  it('returns empty for blank values', () => {
    expect(parseTagCell('')).toEqual([]);
    expect(parseTagCell(undefined)).toEqual([]);
  });
});

describe('parseContactCsv', () => {
  it('parses optional tags column', () => {
    const csv = `phone,name,tags
+15551234567,Alice,"VIP, Lead"
+15559876543,Bob,Customer`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: true,
      hasCompanyColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: ['VIP', 'Lead'],
        },
        {
          phone: '+15559876543',
          name: 'Bob',
          email: undefined,
          company: undefined,
          tagNames: ['Customer'],
        },
      ],
    });
  });

  it('returns empty tagNames when tags column is absent', () => {
    const csv = `phone,name
+15551234567,Alice`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: false,
      hasCompanyColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: [],
        },
      ],
    });
  });

  it('aceita a coluna curso como sinônimo de company', () => {
    const csv = `phone,name,curso
+15551234567,Alice,Direito`;

    const result = parseContactCsv(csv);
    expect(result.hasCompanyColumn).toBe(true);
    expect(result.rows[0].company).toBe('Direito');
  });

  it('continua aceitando a coluna company', () => {
    const csv = `phone,name,company
+15551234567,Alice,Acme Corp`;

    const result = parseContactCsv(csv);
    expect(result.hasCompanyColumn).toBe(true);
    expect(result.rows[0].company).toBe('Acme Corp');
  });

  it('prefere company quando as duas colunas existem', () => {
    const csv = `phone,company,curso
+15551234567,Acme Corp,Direito`;

    expect(parseContactCsv(csv).rows[0].company).toBe('Acme Corp');
  });

  it('aceita a coluna course da versão em inglês', () => {
    const csv = `phone,name,course
+15551234567,Alice,Law`;

    const result = parseContactCsv(csv);
    expect(result.hasCompanyColumn).toBe(true);
    expect(result.rows[0].company).toBe('Law');
  });
});
