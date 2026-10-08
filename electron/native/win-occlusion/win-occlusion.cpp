// win-occlusion.exe
// Reports occlusion geometry for target windows so a screen recorder can
// guarantee that a Window Capture source never shows another window's pixels:
// occluded regions are painted black downstream.
//
// Usage: win-occlusion.exe <hwndHex> [<hwndHex> ...]
//   hwndHex : target window handle, e.g. 0x000A1B2C.
//
// Prints one JSON line to stdout every 200ms:
//   {"windows":{
//      "0xABC": {"rect": {"x":0,"y":0,"w":800,"h":600},
//                 "gone": false, "minimized": false, "cloaked": false,
//                 "occluded": [{"x":10,"y":20,"w":300,"h":200}]}}}
// All rects are in screen coordinates; "occluded" rects are clipped to the
// target window's rect. Windows owned by the parent process (the recorder
// itself) are never treated as occluders, so the recorder's own UI can never
// black out its own capture. Runs until killed by the parent process.
//
// Build (cross-compile on Linux):
//   x86_64-w64-mingw32-g++ -O2 -static -o win-occlusion.exe win-occlusion.cpp -ldwmapi

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dwmapi.h>
#include <tlhelp32.h>

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace {

struct Rect {
  int x, y, w, h;
};

Rect rectFromWin32(const RECT& r) {
  return {r.left, r.top, r.right - r.left, r.bottom - r.top};
}

bool intersects(const Rect& a, const Rect& b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

Rect clipTo(const Rect& inner, const Rect& outer) {
  int x1 = inner.x > outer.x ? inner.x : outer.x;
  int y1 = inner.y > outer.y ? inner.y : outer.y;
  int x2 = (inner.x + inner.w) < (outer.x + outer.w) ? (inner.x + inner.w) : (outer.x + outer.w);
  int y2 = (inner.y + inner.h) < (outer.y + outer.h) ? (inner.y + inner.h) : (outer.y + outer.h);
  Rect r{x1, y1, x2 - x1, y2 - y1};
  if (r.w < 0) r.w = 0;
  if (r.h < 0) r.h = 0;
  return r;
}

// The helper is always spawned by the recorder, so the parent process IS the
// recorder: its windows must never count as occluders.
DWORD parentProcessId() {
  DWORD self = GetCurrentProcessId();
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W entry;
  entry.dwSize = sizeof(entry);
  DWORD parent = 0;
  if (Process32FirstW(snap, &entry)) {
    do {
      if (entry.th32ProcessID == self) {
        parent = entry.th32ParentProcessID;
        break;
      }
    } while (Process32NextW(snap, &entry));
  }
  CloseHandle(snap);
  return parent;
}

void printRect(const Rect& r) {
  printf("{\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d}", r.x, r.y, r.w, r.h);
}

void reportWindow(HWND target, DWORD excludePid) {
  if (!IsWindow(target)) {
    printf("\"gone\":true");
    return;
  }
  printf("\"gone\":false");

  RECT targetRectW;
  if (!GetWindowRect(target, &targetRectW)) {
    printf(",\"gone\":true");
    return;
  }
  const Rect targetRect = rectFromWin32(targetRectW);
  printf(",\"rect\":");
  printRect(targetRect);

  if (IsIconic(target)) {
    // Minimized: nothing visible at all.
    printf(",\"minimized\":true,\"cloaked\":false,\"occluded\":[]");
    return;
  }
  printf(",\"minimized\":false");

  BOOL cloaked = FALSE;
  if (SUCCEEDED(DwmGetWindowAttribute(target, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked) {
    printf(",\"cloaked\":true,\"occluded\":[]");
    return;
  }
  printf(",\"cloaked\":false");

  // Walk z-order above the target; any visible, non-minimized window owned by
  // another process that intersects the target rect is an occluder.
  std::vector<Rect> occluders;
  HWND above = GetWindow(target, GW_HWNDPREV);
  while (above) {
    if (above != target && IsWindowVisible(above) && !IsIconic(above)) {
      DWORD pid = 0;
      GetWindowThreadProcessId(above, &pid);
      if (pid != excludePid) {
        RECT r;
        if (GetWindowRect(above, &r)) {
          const Rect cand = rectFromWin32(r);
          if (cand.w > 0 && cand.h > 0 && intersects(cand, targetRect)) {
            occluders.push_back(clipTo(cand, targetRect));
          }
        }
      }
    }
    above = GetWindow(above, GW_HWNDPREV);
  }

  printf(",\"occluded\":[");
  for (size_t i = 0; i < occluders.size(); ++i) {
    if (i) putchar(',');
    printRect(occluders[i]);
  }
  printf("]");
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: win-occlusion.exe <hwndHex> [hwndHex...]\n");
    return 2;
  }

  const DWORD excludePid = parentProcessId();

  struct Target {
    HWND hwnd;
    std::string label;
  };
  std::vector<Target> targets;
  for (int i = 1; i < argc; ++i) {
    unsigned long long v = strtoull(argv[i], nullptr, 0);
    targets.push_back({(HWND)(uintptr_t)v, argv[i]});
  }

  // Prevent dialog popups from stealing focus / hanging the helper.
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX);

  for (;;) {
    printf("{\"windows\":{");
    for (size_t i = 0; i < targets.size(); ++i) {
      if (i) putchar(',');
      printf("\"%s\":{", targets[i].label.c_str());
      reportWindow(targets[i].hwnd, excludePid);
      putchar('}');
    }
    printf("}}\n");
    fflush(stdout);
    Sleep(200);
  }
}
