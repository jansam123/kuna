import { run } from './hosts/exec'

// JavaScript for Automation, run by osascript: macOS's own PDFKit, so Kuna bundles no library that writes PDFs
const ONE_PAGE = `ObjC.import('Quartz')
function run([n]) {
  const page = $.PDFDocument.alloc.initWithData($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile).pageAtIndex(Number(n))
  const out = $.PDFDocument.alloc.init
  out.insertPageAtIndex(page, 0)
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(out.dataRepresentation)
}`

/** Page `page` (from 0) of a PDF as a PDF of its own, as much vector as it was; null when there is no such page to take out. */
export async function pdfPage(pdf: Uint8Array, page: number): Promise<Buffer | null> {
  const res = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ONE_PAGE, String(page)], { stdin: Buffer.from(pdf) })
  return res.stdout.subarray(0, 4).toString() === '%PDF' ? res.stdout : null
}
