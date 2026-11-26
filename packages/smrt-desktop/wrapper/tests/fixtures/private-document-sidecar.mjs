// Controlled synthetic native acceptance fixture. No personal workspace or data.
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const session = randomBytes(24).toString('hex');
const evidence = process.env.PDF_FIXTURE_EVIDENCE;
const ownerRoute = process.env.PDF_FIXTURE_OWNER_ROUTE ?? '/owner/claim';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];
const stream = 'BT /F1 22 Tf 50 700 Td (SMRT synthetic private PDF) Tj ET';
objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
let content = '%PDF-1.7\n';
const offsets = [0];
objects.forEach((body, i) => { offsets.push(Buffer.byteLength(content)); content += `${i + 1} 0 obj\n${body}\nendobj\n`; });
const xref = Buffer.byteLength(content);
content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const pdf = Buffer.from(content);
if (evidence) writeFileSync(join(evidence, 'expected.pdf'), pdf, { mode: 0o600 });
const results = { authenticatedFetches: 0, deniedFetches: 0, ownerProofAccepted: false, ownerRouteRequests: 0, foreignRequests: 0, adversarialAttempts: [], sha256: createHash('sha256').update(pdf).digest('hex') };
const record = () => { if (evidence) writeFileSync(join(evidence, 'fixture-results.json'), JSON.stringify(results), { mode: 0o600 }); };
const trap = createServer((req, res) => { results.foreignRequests++; record(); res.writeHead(403).end(); });
trap.listen(0, '127.0.0.1');
const server = createServer((req, res) => {
  const url = new URL(req.url, process.env.ORIGIN);
  const authenticated = req.headers.cookie?.split(';').map((part) => part.trim()).includes(`smrt_pdf_fixture_session=${session}`);
  if (url.pathname === '/fixture-ack') { results.adversarialAttempts.push({ kind: url.searchParams.get('kind'), sameRoot: url.searchParams.get('sameRoot') }); record(); return res.end('ok'); }
  if (url.pathname === '/health') return res.end('ok');
  if (url.pathname === ownerRoute) {
    results.ownerRouteRequests++; record();
    if (url.searchParams.get('launch') !== process.env.SMRT_DESKTOP_OWNER_LINK_SECRET) return res.writeHead(403).end();
    results.ownerProofAccepted = true; record();
    return res.writeHead(303, { Location: '/', 'Set-Cookie': `smrt_pdf_fixture_session=${session}; HttpOnly; SameSite=Lax; Path=/` }).end();
  }
  if (url.pathname === '/') {
    if (!authenticated) return res.writeHead(403).end('Signed out');
    return res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><html><head><title>SMRT Private PDF Fixture</title><style>body{font:14px system-ui;margin:12px}h1{font-size:18px;margin:0 0 8px}p{margin:5px 0}</style></head><body>${process.env.PDF_FIXTURE_AUTO_ADVERSARIES === '1' ? `<script>window.addEventListener('load',async()=>{const original=location.href;await fetch('/fixture-ack?kind=direct-attempt');location.href='smrt-private-document://open/?cap=forged&url=http%3A%2F%2F127.0.0.1%3A1%2Fdocuments%2Fauthorized-001%2Fpdf';setTimeout(async()=>{await fetch('/fixture-ack?kind=direct-result&sameRoot='+(location.href===original));const frame=document.createElement('iframe');frame.sandbox='allow-scripts allow-top-navigation';frame.src='/foreign-frame';document.body.appendChild(frame);setTimeout(()=>fetch('/fixture-ack?kind=frame-result&sameRoot='+(location.href===original)),800)},500)})</script>` : ''}<h1>Controlled owner workspace</h1><p>No personal data. Opening and saving never approve or send.</p><p><a target='_blank' href='/documents/authorized-001/pdf'>Open PDF</a></p><p><a target='_blank' href='/documents/other-001/pdf'>Cross-owner PDF</a></p><p><a target='_blank' href='/documents/redirect/pdf'>Redirect PDF</a></p><p><a target='_blank' href='http://127.0.0.1:${trap.address().port}/documents/authorized-001/pdf'>Foreign-port PDF</a></p><p><a target='_blank' href='/documents/record-9001/pdf'>Custom owner route</a></p><p><a target='_blank' href='/documents/record-9001/pdf?launch=forbidden'>Owner proof query</a></p><p><a target='_blank' href='/owner/claim?launch=forbidden'>Forbidden owner link</a></p><p><a download href='/documents/authorized-001/pdf'>Download PDF</a></p><p><a href='smrt-private-document://open/?cap=forged&url=http%3A%2F%2F127.0.0.1%3A1%2Fdocuments%2Fauthorized-001%2Fpdf'>Forged document action</a></p><p><button onclick="const frame=document.createElement('iframe');frame.sandbox='allow-scripts allow-top-navigation';frame.src='/foreign-frame';document.body.appendChild(frame)">Foreign frame action</button></p><p><a href='/signout'>Sign out</a></p></body></html>`);
  }
  if (url.pathname === '/foreign-frame') return res.writeHead(200, { 'Content-Type': 'text/html' }).end("<script>fetch('/fixture-ack?kind=frame-attempt',{mode:'no-cors'}).finally(()=>{top.location.href='smrt-private-document://open/?cap=forged&url=http%3A%2F%2F127.0.0.1%3A1%2Fdocuments%2Fauthorized-001%2Fpdf'})</script>");
  if (url.pathname === '/signout') return res.writeHead(200, { 'Set-Cookie': 'smrt_pdf_fixture_session=; Max-Age=0; Path=/', 'Content-Type': 'text/html' }).end("<a target='_blank' href='/documents/authorized-001/pdf'>Anonymous PDF</a>");
  if (url.pathname.startsWith('/documents/')) {
    if (!authenticated || url.pathname === '/documents/other-001/pdf') { results.deniedFetches++; record(); return res.writeHead(403).end(); }
    if (url.pathname === '/documents/redirect/pdf') return res.writeHead(302, { Location: `http://127.0.0.1:${trap.address().port}/documents/authorized-001/pdf` }).end();
    results.authenticatedFetches++; record();
    return res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Content-Disposition': 'inline' }).end(pdf);
  }
  res.writeHead(404).end();
});
server.listen(Number(process.env.PORT), process.env.HOST);
process.on('SIGTERM', () => { record(); server.close(); trap.close(); });
