const assert = require("node:assert/strict");
const test = require("node:test");

const names = require("../src-tauri/download-names.cjs");

const BASE = "https://app.slack.com/client/T1/C1";

// Minimal stand-ins for the DOM nodes the resolver touches: getAttribute,
// querySelector, parentElement and textContent.
function element(attributes = {}, children = []) {
  const node = {
    nodeType: 1,
    attributes,
    children,
    parentElement: null,
    href: attributes.href,
    textContent: attributes.textContent || "",
    getAttribute: (name) => (name in attributes ? attributes[name] : null),
    querySelector: (selector) => {
      const matches = (candidate) => {
        const own = candidate.attributes;
        if (selector.includes("a[download]") && own.tag === "a" && own.download != null) return true;
        if (selector.includes('a[href*="/download/"]') && own.tag === "a" && (own.href || "").includes("/download/")) return true;
        if (selector.includes("data-file-name") && own["data-file-name"] != null) return true;
        if (selector.includes("file_name") && own["data-qa"] === "file_name") return true;
        return false;
      };
      const walk = (parent) => {
        for (const child of parent.children) {
          if (matches(child)) return child;
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(node);
    },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

test("ignores Slack's placeholder names in URLs", () => {
  assert.equal(
    names.filenameFromUrl("https://files.slack.com/files-tmb/T05AB-F09XY-abc/image_720.png", BASE),
    "",
  );
  assert.equal(
    names.filenameFromUrl("https://files.slack.com/files-pri/T05AB-F09XY/download/", BASE),
    "",
  );
  // Slack rewrites every non-ASCII byte of the name to `_` in the URL.
  assert.equal(
    names.filenameFromUrl(
      "https://files.slack.com/files-pri/T05AB-F09XY/download/____________.fig?origin_team=T05AB",
      BASE,
    ),
    "",
  );
});

test("resolves the real name for a Korean download button", () => {
  // The markup Slack ships for the download icon next to a file.
  const button = element({
    tag: "a",
    "data-qa": "download_action",
    "aria-label": "대리결재.fig 다운로드",
    href: "https://files.slack.com/files-pri/T06Q-F0C1/download/____________.fig?origin_team=T06Q",
  });

  assert.equal(
    names.resolveFilename({
      element: button,
      url: button.href,
      fallbackStem: "slack-file",
      baseHref: BASE,
    }),
    "대리결재.fig",
  );
});

test("takes the real name out of a Slack file URL", () => {
  assert.equal(
    names.filenameFromUrl(
      "https://files.slack.com/files-pri/T05AB-F09XY/download/2026%20%EA%B3%84%ED%9A%8D%EC%84%9C.pdf",
      BASE,
    ),
    "2026 계획서.pdf",
  );
  assert.equal(
    names.filenameFromUrl("https://files.slack.com/files-pri/T1-F1/download/archive.zip?t=x", BASE),
    "archive.zip",
  );
});

test("reads the name from the surrounding markup", () => {
  const link = element({
    tag: "a",
    href: "https://files.slack.com/files-pri/T1-F1/download/quarterly%20report.pdf",
    download: "",
  });
  const image = element({ tag: "img", alt: "" });
  element({}, [image, link]);

  assert.equal(names.filenameFromElement(image, BASE), "quarterly report.pdf");
  assert.equal(
    names.filenameFromElement(element({ tag: "img", alt: "design mock v3.png" }), BASE),
    "design mock v3.png",
  );
  assert.equal(
    names.filenameFromElement(element({ tag: "a", "aria-label": "Download 회의록.pdf" }), BASE),
    "회의록.pdf",
  );
  // Korean Slack puts the verb after the name: "대리결재.fig 다운로드".
  assert.equal(
    names.filenameFromElement(
      element({ tag: "a", "data-qa": "download_action", "aria-label": "대리결재.fig 다운로드" }),
      BASE,
    ),
    "대리결재.fig",
  );
  // Descriptive alt text is not a file name.
  assert.equal(
    names.filenameFromElement(element({ tag: "img", alt: "A photo of a whiteboard" }), BASE),
    "",
  );
});

test("prefers the server name, then the page, then the URL", () => {
  const link = element({
    tag: "a",
    href: "https://files.slack.com/files-pri/T1-F1/download/from-page.pdf",
    download: "",
  });
  const anchor = element({ tag: "span" }, [link]);

  assert.equal(
    names.resolveFilename({
      disposition: "attachment; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf",
      element: anchor,
      url: "https://files.slack.com/files-pri/T1-F1/download/from-url.pdf",
      fallbackStem: "slack-file",
      baseHref: BASE,
    }),
    "보고서.pdf",
  );
  assert.equal(
    names.resolveFilename({
      element: anchor,
      url: "https://files.slack.com/files-pri/T1-F1/download/from-url.pdf",
      fallbackStem: "slack-file",
      baseHref: BASE,
    }),
    "from-page.pdf",
  );
  assert.equal(
    names.resolveFilename({
      url: "https://files.slack.com/files-pri/T1-F1/download/from-url.pdf",
      fallbackStem: "slack-file",
      baseHref: BASE,
    }),
    "from-url.pdf",
  );
});

test("falls back to a timestamped name so saves stay distinct", () => {
  const now = new Date(2026, 0, 2, 3, 4, 5);

  assert.equal(
    names.resolveFilename({
      url: "https://files.slack.com/files-tmb/T1-F1-abc/image_720.png",
      fallbackStem: "slack-image",
      baseHref: BASE,
      now,
    }),
    "slack-image-20260102-030405.png",
  );
  assert.equal(
    names.resolveFilename({
      url: "https://files.slack.com/files-pri/T1-F1/download",
      fallbackStem: "slack-file",
      baseHref: BASE,
      now,
    }),
    "slack-file-20260102-030405",
  );
});
