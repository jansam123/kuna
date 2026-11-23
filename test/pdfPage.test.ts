import { describe, expect, it } from 'vitest'
import { pdfPage } from '../src/main/pdfPage'

/** A PDF of empty pages of these sizes, in points. */
function pdfOf(sizes: [number, number][]): Buffer {
  const kids = sizes.map((_, i) => `${i + 3} 0 R`).join(' ')
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${sizes.length} >>`, ...sizes.map(([w, h]) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] >>`)]
  let out = '%PDF-1.4\n'
  const at = objs.map((o, i) => {
    const p = out.length
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
    return p
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out)
}

describe('one page of a PDF, for the clipboard', () => {
  const deck = pdfOf([
    [200, 100],
    [300, 150],
    [400, 200]
  ])

  it('is a PDF of that page alone', async () => {
    const page = await pdfPage(deck, 1)
    expect(page?.toString('latin1')).toContain('MediaBox [0 0 300 150]')
    // a PDF of one page: it has a first page and no second
    expect(await pdfPage(page!, 0)).not.toBeNull()
    expect(await pdfPage(page!, 1)).toBeNull()
  })

  it('is nothing for a page that is not there, or a file that is no PDF', async () => {
    expect(await pdfPage(deck, 3)).toBeNull()
    expect(await pdfPage(Buffer.from('not a PDF'), 0)).toBeNull()
  })
})
