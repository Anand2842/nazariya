"""List / extract members of a remote ZIP using HTTP range requests (only the needed bytes are downloaded)."""
import io, struct, sys, urllib.request, zipfile
UA = {"User-Agent": "NazariyaEval/1.0 (dataset evaluation)"}
class RangeFile(io.RawIOBase):
    def __init__(self, url):
        self.url, self.pos = url, 0
        req = urllib.request.Request(url, method="HEAD", headers=UA)
        self.size = int(urllib.request.urlopen(req).headers["Content-Length"])
    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos
    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos
    def read(self, n=-1):
        if n < 0: n = self.size - self.pos
        if n == 0 or self.pos >= self.size: return b""
        end = min(self.size, self.pos + n) - 1
        req = urllib.request.Request(self.url, headers={**UA, "Range": f"bytes={self.pos}-{end}"})
        data = urllib.request.urlopen(req).read()
        self.pos += len(data)
        return data
    def readinto(self, b):
        d = self.read(len(b)); b[:len(d)] = d; return len(d)
url, cmd = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(io.BufferedReader(RangeFile(url), buffer_size=1 << 20))
if cmd == "list":
    import collections
    tops = collections.defaultdict(lambda: [0, 0])
    for i in z.infolist():
        parts = i.filename.split("/")
        k = "/".join(parts[:2]); tops[k][0] += 1; tops[k][1] += i.file_size
    for k, (n, b) in sorted(tops.items()): print(f"{b/1e6:9.1f} MB {n:6d} files  {k}")
else:  # extract <prefix> <outdir>
    prefix, out = sys.argv[3], sys.argv[4]
    for i in z.infolist():
        if i.filename.startswith(prefix) and not i.is_dir(): z.extract(i, out)
    print("extracted", prefix)
