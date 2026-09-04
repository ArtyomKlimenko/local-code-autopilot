# Upstream components

The Preact message, thinking disclosure, expandable tool-result layout, and
memoized Markdown rendering in client/message-row.jsx are adapted from:

https://github.com/xuzhixiangya/pi-web-ui

Revision: 4286de23c3e5e4bd6f4d4dcba0dfa75cf6c5345d

Original files: frontend/components/message-row.tsx,
frontend/components/tool-call-row.tsx, frontend/lib/markdown.ts.
The application icon is frontend/icons/icon-192.png from the same revision.

Changes: Russian interface, lucide-preact icons, text-only tool results,
Markdown HTML disabled, remote image loading disabled, autopilot event and
status adapters, reduced dependency set. The upstream agent SDK/server is not
bundled; the existing local GPU launcher and supervisor own execution.

## MIT License

Copyright (c) 2026 Martin Grimmer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
