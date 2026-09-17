/**
 * A MINIMAL XLSX WRITER
 *
 * Why this exists rather than a library: the map is self-contained by
 * requirement. It vendors D3 and TopoJSON and loads nothing from a CDN, and
 * the standalone build in dist/ inlines every byte it needs. Pulling SheetJS
 * in for one button would break that, and a CSV would not be the Excel file
 * that was actually asked for.
 *
 * An .xlsx is a ZIP of XML parts. The only hard problems in writing one by
 * hand are the ZIP container and the CRC32 of each entry, and both are short.
 * Entries are STORED rather than deflated: the spec allows it, Excel opens it,
 * and the alternative is shipping an implementation of DEFLATE. The dataset is
 * a few hundred rows, so the cost is a file about three times larger than it
 * needs to be, measured in hundreds of kilobytes.
 *
 * Scope: strings and numbers, one header row per sheet, no formatting beyond
 * a bold header and frozen top row. That is what a data export needs.
 *
 * Exposes window.DLXlsx.
 */
const DLXlsx = (() => {
  // --------------------------------------------------------------------
  // CRC32, table-driven. Required per ZIP entry.
  // --------------------------------------------------------------------
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const utf8 = (text) => new TextEncoder().encode(text);

  // --------------------------------------------------------------------
  // ZIP container
  // --------------------------------------------------------------------

  /**
   * Build a ZIP from [{name, bytes}].
   *
   * Local header, then data, per entry; then the central directory; then the
   * end-of-central-directory record. Everything little-endian. Dates are
   * written as a fixed 1980-01-01, because a reproducible export is worth
   * more here than a timestamp nobody reads.
   */
  function zip(entries) {
    const chunks = [];
    const directory = [];
    let offset = 0;

    const u16 = (v) => [v & 0xFF, (v >>> 8) & 0xFF];
    const u32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

    entries.forEach(entry => {
      const name = utf8(entry.name);
      const data = entry.bytes;
      const sum = crc32(data);

      const local = [
        ...u32(0x04034B50),   // local file header signature
        ...u16(20),           // version needed
        ...u16(0x0800),       // flags: UTF-8 names
        ...u16(0),            // method: stored
        ...u16(0), ...u16(0x0021),  // time, date (1980-01-01)
        ...u32(sum),
        ...u32(data.length),  // compressed size
        ...u32(data.length),  // uncompressed size
        ...u16(name.length),
        ...u16(0)             // extra field length
      ];

      chunks.push(new Uint8Array(local), name, data);

      directory.push([
        ...u32(0x02014B50),   // central directory header signature
        ...u16(20), ...u16(20),
        ...u16(0x0800),
        ...u16(0),
        ...u16(0), ...u16(0x0021),
        ...u32(sum),
        ...u32(data.length),
        ...u32(data.length),
        ...u16(name.length),
        ...u16(0), ...u16(0),  // extra, comment
        ...u16(0),             // disk number
        ...u16(0),             // internal attributes
        ...u32(0),             // external attributes
        ...u32(offset),        // offset of local header
        ...Array.from(name)
      ]);

      offset += local.length + name.length + data.length;
    });

    const central = new Uint8Array(directory.flat());
    const end = new Uint8Array([
      ...u32(0x06054B50),
      ...u16(0), ...u16(0),
      ...u16(entries.length), ...u16(entries.length),
      ...u32(central.length),
      ...u32(offset),
      ...u16(0)
    ]);

    return new Blob([...chunks, central, end],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // --------------------------------------------------------------------
  // XML
  // --------------------------------------------------------------------

  // XML 1.0 forbids most control characters outright, so they are stripped
  // rather than escaped: a stray one makes the whole workbook unopenable.
  const xmlEscape = (value) => String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  /** A1, B1 ... Z1, AA1. Column index is zero-based. */
  function cellRef(column, row) {
    let name = '';
    let n = column;
    do {
      name = String.fromCharCode(65 + (n % 26)) + name;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return name + row;
  }

  /**
   * One row of cells.
   *
   * Numbers are written as numbers so Excel can sum and sort them; everything
   * else is an inline string. Inline strings avoid the shared-string table,
   * which is a size optimisation this export does not need.
   *
   * null and undefined produce an empty cell rather than the text "null",
   * which is what a naive String() would give.
   */
  function rowXml(values, rowNumber, styleIndex) {
    const cells = values.map((value, column) => {
      const ref = cellRef(column, rowNumber);
      const style = styleIndex ? ` s="${styleIndex}"` : '';

      if (value === null || value === undefined || value === '') {
        return `<c r="${ref}"${style}/>`;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${ref}"${style}><v>${value}</v></c>`;
      }
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${
        xmlEscape(value)}</t></is></c>`;
    }).join('');

    return `<row r="${rowNumber}">${cells}</row>`;
  }

  /** Widen every column to fit its widest value, within reason. */
  function columnsXml(header, rows) {
    return '<cols>' + header.map((title, i) => {
      let widest = String(title).length;
      rows.forEach(row => {
        const value = row[i];
        if (value !== null && value !== undefined) {
          widest = Math.max(widest, String(value).length);
        }
      });
      const width = Math.min(60, Math.max(9, widest + 2));
      return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
    }).join('') + '</cols>';
  }

  function sheetXml(sheet) {
    const header = sheet.header || [];
    const rows = sheet.rows || [];

    const body = [rowXml(header, 1, 1)]
      .concat(rows.map((row, i) => rowXml(row, i + 2, 0)))
      .join('');

    const lastCell = cellRef(Math.max(0, header.length - 1), rows.length + 1);

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><outlinePr summaryBelow="1" summaryRight="1"/></sheetPr>
<dimension ref="A1:${lastCell}"/>
<sheetViews><sheetView workbookViewId="0">
<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${columnsXml(header, rows)}
<sheetData>${body}</sheetData>
<autoFilter ref="A1:${cellRef(Math.max(0, header.length - 1), rows.length + 1)}"/>
</worksheet>`;
  }

  // Two styles: 0 is the default, 1 is the bold header.
  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
</fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`;

  /**
   * Build a workbook.
   *
   * `sheets` is [{ name, header: [...], rows: [[...], ...] }].
   * Sheet names are truncated to Excel's 31-character limit and stripped of
   * the characters it refuses, because a bad name is another way to produce a
   * file that will not open.
   */
  function build(sheets) {
    const safeName = (name, index) =>
      (String(name).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31)) || `Sheet${index + 1}`;

    const named = sheets.map((sheet, i) => ({ ...sheet, name: safeName(sheet.name, i) }));

    const parts = [
      {
        name: '[Content_Types].xml',
        text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${named.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`
      },
      {
        name: '_rels/.rels',
        text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
      },
      {
        name: 'xl/workbook.xml',
        text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${named.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('\n')}
</sheets>
</workbook>`
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
      },
      { name: 'xl/styles.xml', text: STYLES }
    ];

    named.forEach((sheet, i) => {
      parts.push({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(sheet) });
    });

    return zip(parts.map(part => ({ name: part.name, bytes: utf8(part.text) })));
  }

  /** Build and hand it to the browser as a download. */
  function download(sheets, filename) {
    const blob = build(sheets);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();

    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  return { build, download, crc32, cellRef };
})();

window.DLXlsx = DLXlsx;
console.log('[Xlsx] Module loaded');
