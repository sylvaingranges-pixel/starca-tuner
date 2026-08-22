/* Minimal, dependency-free XML parser / writer.
 * Works both in the browser and in Node (used by the CLI test tools).
 * Only supports what GPX needs: elements, attributes, text, CDATA, comments.
 */
(function (global) {
  'use strict';

  function findTagEnd(s, from) {
    var q = 0;
    for (var i = from; i < s.length; i++) {
      var c = s[i];
      if (q) { if (c === q) q = 0; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '>') return i;
    }
    return -1;
  }

  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, function (m, e) {
      switch (e) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
      }
      if (e[0] === '#') {
        var code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return m;
    });
  }

  function encodeEntities(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }

  function encodeAttr(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  function parseAttrs(src) {
    var attrs = [];
    var re = /([^\s=\/]+)\s*=\s*("([^"]*)"|'([^']*)')/g, m;
    while ((m = re.exec(src))) {
      attrs.push({ name: m[1], value: decodeEntities(m[3] !== undefined ? m[3] : m[4]) });
    }
    return attrs;
  }

  /** Parse an XML document into a light tree. Returns the root element. */
  function parse(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var doc = { name: '#document', attrs: [], children: [], declaration: null };
    var stack = [doc];
    var i = 0, len = text.length;

    while (i < len) {
      var lt = text.indexOf('<', i);
      if (lt < 0) break;
      if (lt > i) {
        var raw = text.slice(i, lt);
        if (raw.trim()) stack[stack.length - 1].children.push({ name: '#text', text: decodeEntities(raw) });
      }
      if (text.startsWith('<?', lt)) {
        var e1 = text.indexOf('?>', lt);
        if (e1 < 0) break;
        doc.declaration = text.slice(lt, e1 + 2);
        i = e1 + 2; continue;
      }
      if (text.startsWith('<!--', lt)) {
        var e2 = text.indexOf('-->', lt);
        i = e2 < 0 ? len : e2 + 3; continue;
      }
      if (text.startsWith('<![CDATA[', lt)) {
        var e3 = text.indexOf(']]>', lt);
        if (e3 < 0) break;
        stack[stack.length - 1].children.push({ name: '#text', text: text.slice(lt + 9, e3), cdata: true });
        i = e3 + 3; continue;
      }
      if (text.startsWith('<!', lt)) {
        var e4 = text.indexOf('>', lt);
        i = e4 < 0 ? len : e4 + 1; continue;
      }
      if (text.startsWith('</', lt)) {
        var e5 = text.indexOf('>', lt);
        if (stack.length > 1) stack.pop();
        i = (e5 < 0 ? len : e5 + 1); continue;
      }
      var end = findTagEnd(text, lt);
      if (end < 0) break;
      var body = text.slice(lt + 1, end);
      var selfClose = /\/\s*$/.test(body);
      if (selfClose) body = body.replace(/\/\s*$/, '');
      var sp = body.search(/[\s\/]/);
      var name = sp < 0 ? body : body.slice(0, sp);
      var node = { name: name, attrs: sp < 0 ? [] : parseAttrs(body.slice(sp)), children: [] };
      stack[stack.length - 1].children.push(node);
      if (!selfClose) stack.push(node);
      i = end + 1;
    }

    var root = null;
    for (var k = 0; k < doc.children.length; k++) {
      if (doc.children[k].name !== '#text') { root = doc.children[k]; break; }
    }
    if (root) root.declaration = doc.declaration;
    return root;
  }

  function attr(node, name) {
    if (!node) return undefined;
    for (var i = 0; i < node.attrs.length; i++) if (node.attrs[i].name === name) return node.attrs[i].value;
    return undefined;
  }

  function localName(n) {
    var c = n.indexOf(':');
    return c < 0 ? n : n.slice(c + 1);
  }

  function child(node, localOrQName) {
    if (!node) return null;
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.name === localOrQName || localName(c.name) === localOrQName) return c;
    }
    return null;
  }

  function children(node, localOrQName) {
    var out = [];
    if (!node) return out;
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.name === '#text') continue;
      if (!localOrQName || c.name === localOrQName || localName(c.name) === localOrQName) out.push(c);
    }
    return out;
  }

  function text(node) {
    if (!node) return '';
    var s = '';
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.name === '#text') s += c.text;
      else s += text(c);
    }
    return s;
  }

  /** Serialize a node back to XML with 2-space indentation. */
  function serialize(node, indent) {
    indent = indent || '';
    if (node.name === '#text') return indent + encodeEntities(node.text.trim()) + '\n';
    var open = '<' + node.name;
    for (var i = 0; i < node.attrs.length; i++) open += ' ' + node.attrs[i].name + '="' + encodeAttr(node.attrs[i].value) + '"';
    var kids = node.children.filter(function (c) { return c.name !== '#text' || c.text.trim(); });
    if (!kids.length) return indent + open + ' />\n';
    if (kids.length === 1 && kids[0].name === '#text') {
      return indent + open + '>' + encodeEntities(kids[0].text.trim()) + '</' + node.name + '>\n';
    }
    var out = indent + open + '>\n';
    for (var j = 0; j < kids.length; j++) out += serialize(kids[j], indent + '  ');
    return out + indent + '</' + node.name + '>\n';
  }

  global.XMLLite = {
    parse: parse, attr: attr, child: child, children: children, text: text,
    serialize: serialize, localName: localName,
    encodeEntities: encodeEntities, encodeAttr: encodeAttr
  };
})(typeof window !== 'undefined' ? window : globalThis);
