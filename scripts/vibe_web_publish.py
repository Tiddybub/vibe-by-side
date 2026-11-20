"""Upload a Godot web build (vibe-web/) straight into a Vibe by Side world, so the preview
appears without the pilot's browser doing the upload.

Usage: FILES_URL=<files Worker address> python vibe_web_publish.py <game folder> <world id> <tickets.json>
  tickets.json = {"vibe-web/index.pck": "<ticket>", ...} from the MCP upload_url tool (one per file,
  tickets stay good for an hour and may be reused for the multipart pieces).
Files over 90 MB go up in 50 MB pieces (?mp=start / part / done), like the site's own putFile().
Prints one line per file; exit 1 if any failed. Then call the MCP `uploaded` tool per file.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

FILES = os.environ["FILES_URL"]  # the files Worker address
MB = 1048576
PIECE = 50 * MB


def req(url, data=None, method="PUT"):
    # Cloudflare refuses Python's default User-Agent (error 1010); any browser-like name passes.
    r = urllib.request.Request(url, data=data, method=method, headers={"User-Agent": "vibe-web-publish/1 (curl-like)"})
    with urllib.request.urlopen(r, timeout=600) as resp:
        return json.loads(resp.read() or b"{}")


def put(world, path, local, ticket):
    url = "%s/file/%s/%s?ticket=%s" % (FILES, world, "/".join(urllib.parse.quote(p) for p in path.split("/")), ticket)
    size = os.path.getsize(local)
    if size <= 90 * MB:
        with open(local, "rb") as f:
            return req(url, f.read())
    upload = req(url + "&mp=start")["id"]
    parts = []
    with open(local, "rb") as f:
        n = 1
        while True:
            chunk = f.read(PIECE)
            if not chunk:
                break
            parts.append(req("%s&mp=part&id=%s&n=%d" % (url, urllib.parse.quote(upload), n), chunk))
            print("  %s piece %d (%d MB)" % (path, n, (n * PIECE) // MB), flush=True)
            n += 1
    return req("%s&mp=done&id=%s" % (url, urllib.parse.quote(upload)), json.dumps(parts).encode())


def main():
    folder, world, tickets = sys.argv[1], sys.argv[2], json.load(open(sys.argv[3]))
    failed = 0
    for path, ticket in tickets.items():
        local = os.path.join(folder, *path.split("/"))
        try:
            out = put(world, path, local, ticket)
            print("OK  %s %s" % (path, out.get("bytes", "")), flush=True)
        except Exception as e:  # noqa: BLE001
            failed += 1
            print("ERR %s %s" % (path, e), flush=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
