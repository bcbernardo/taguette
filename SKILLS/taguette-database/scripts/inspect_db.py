#!/usr/bin/env python3
"""Read-only inspector for Taguette SQLite workspaces (stdlib only).

Usage:
  inspect_db.py DB summary
  inspect_db.py DB tags [PROJECT_ID]
  inspect_db.py DB highlights --tag PATH [--project ID] [--limit N] [--json]
  inspect_db.py DB check
  inspect_db.py DB sql "SELECT ..."
"""
import argparse
import json
import re
import sqlite3
import sys

HEAD = '63d7ca28fc0c'
APP_ID = 0x54677474
TABLES = ['users', 'projects', 'project_members', 'documents', 'highlights',
          'tags', 'highlight_tags', 'commands']


def open_ro(path):
    c = sqlite3.connect('file:%s?mode=ro' % path, uri=True)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys=ON')
    return c


def summary(c, a):
    rev = c.execute('SELECT version_num FROM alembic_version').fetchone()
    app = c.execute('PRAGMA application_id').fetchone()[0]
    print('revision: %s (%s)' % (rev[0], 'head' if rev[0] == HEAD
                                 else 'NOT head %s' % HEAD))
    print('application_id: %s (%s)' % (hex(app), 'ok' if app == APP_ID
                                       else 'unexpected'))
    for t in TABLES:
        print('%-15s %d' % (t, c.execute('SELECT count(*) FROM %s' % t)
                            .fetchone()[0]))
    for r in c.execute('SELECT id, name, created FROM projects'):
        print('project %d: %s (%s)' % (r['id'], r['name'], r['created']))
        for d in c.execute('SELECT id, name FROM documents WHERE project_id=?',
                           (r['id'],)):
            n = c.execute('SELECT count(*) FROM highlights WHERE document_id=?',
                          (d['id'],)).fetchone()[0]
            print('  document %d: %s [%d highlights]' % (d['id'], d['name'], n))


def tags(c, a):
    q = 'SELECT id, path, parent_id, project_id FROM tags'
    rows = c.execute(q + (' WHERE project_id=?' if a.project_id else ''),
                     (a.project_id,) if a.project_id else ()).fetchall()
    counts = dict(c.execute('SELECT tag_id, count(*) FROM highlight_tags '
                            'GROUP BY tag_id').fetchall())
    kids = {}
    for r in rows:
        kids.setdefault((r['project_id'], r['parent_id']), []).append(r)

    def show(pid, parent, depth):
        for r in sorted(kids.get((pid, parent), []), key=lambda r: r['path']):
            print('%s%s  [id=%d, %d highlights]' % (
                '  ' * depth, r['path'], r['id'], counts.get(r['id'], 0)))
            show(pid, r['id'], depth + 1)
    for pid in sorted({r['project_id'] for r in rows}):
        print('project %d' % pid)
        show(pid, None, 1)


def highlights(c, a):
    q = ('SELECT h.id, d.id AS document_id, d.name AS document, '
         'h.start_offset, h.end_offset, h.snippet '
         'FROM highlights h JOIN documents d ON d.id=h.document_id '
         'JOIN highlight_tags ht ON ht.highlight_id=h.id '
         'JOIN tags t ON t.id=ht.tag_id WHERE t.path=?')
    args = [a.tag]
    if a.project:
        q += ' AND t.project_id=?'
        args.append(a.project)
    q += ' ORDER BY d.id, h.start_offset LIMIT ?'
    args.append(a.limit)
    rows = [dict(r) for r in c.execute(q, args)]
    for r in rows:
        r['text'] = re.sub(r'<[^>]+>', '', r['snippet'])
    if a.json:
        json.dump(rows, sys.stdout, indent=2, ensure_ascii=False)
        print()
        return
    for r in rows:
        print('#%d doc=%s [%d:%d] %s' % (
            r['id'], r['document'], r['start_offset'], r['end_offset'],
            r['text'][:200].replace('\n', ' ')))


def check(c, a):
    """Verify invariants: ancestor inheritance, tag/project match, cycles,
    offsets sanity."""
    problems = 0
    parent = dict(c.execute('SELECT id, parent_id FROM tags').fetchall())
    # cycles
    for t in parent:
        seen, cur = set(), t
        while cur is not None:
            if cur in seen:
                print('CYCLE at tag', t)
                problems += 1
                break
            seen.add(cur)
            cur = parent.get(cur)
    links = {}
    for r in c.execute('SELECT highlight_id, tag_id FROM highlight_tags'):
        links.setdefault(r[0], set()).add(r[1])
    for h, ts in links.items():
        for t in ts:
            p = parent.get(t)
            while p is not None:
                if p not in ts:
                    print('highlight %d has tag %d but not ancestor %d'
                          % (h, t, p))
                    problems += 1
                    break
                p = parent.get(p)
    for r in c.execute(
            'SELECT ht.highlight_id, ht.tag_id FROM highlight_tags ht '
            'JOIN highlights h ON h.id=ht.highlight_id '
            'JOIN documents d ON d.id=h.document_id '
            'JOIN tags t ON t.id=ht.tag_id WHERE t.project_id!=d.project_id'):
        print('highlight %d linked to tag %d of another project' % tuple(r))
        problems += 1
    for r in c.execute('SELECT id FROM highlights WHERE start_offset<0 OR '
                       'end_offset<=start_offset'):
        print('highlight %d has invalid offsets' % r[0])
        problems += 1
    for r in c.execute('PRAGMA foreign_key_check'):
        print('FK violation:', tuple(r))
        problems += 1
    print('OK' if not problems else '%d problem(s)' % problems)
    return 1 if problems else 0


def sql(c, a):
    s = a.query.strip().rstrip(';')
    if not re.match(r'(?is)^(select|with|pragma\s+table_info)\b', s) \
            or ';' in s:
        sys.exit('only a single SELECT/WITH statement is allowed')
    cur = c.execute(s)
    rows = cur.fetchall()
    print(json.dumps([dict(r) for r in rows], indent=2, ensure_ascii=False,
                     default=str))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('db')
    sub = p.add_subparsers(dest='cmd', required=True)
    sub.add_parser('summary').set_defaults(f=summary)
    s = sub.add_parser('tags')
    s.add_argument('project_id', nargs='?', type=int)
    s.set_defaults(f=tags)
    s = sub.add_parser('highlights')
    s.add_argument('--tag', required=True)
    s.add_argument('--project', type=int)
    s.add_argument('--limit', type=int, default=50)
    s.add_argument('--json', action='store_true')
    s.set_defaults(f=highlights)
    sub.add_parser('check').set_defaults(f=check)
    s = sub.add_parser('sql')
    s.add_argument('query')
    s.set_defaults(f=sql)
    a = p.parse_args()
    sys.exit(a.f(open_ro(a.db), a) or 0)


if __name__ == '__main__':
    main()
