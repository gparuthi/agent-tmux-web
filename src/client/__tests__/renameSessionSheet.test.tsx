import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RenameSessionSheet } from "../RenameSessionSheet.js";

describe("RenameSessionSheet", () => {
  it("prefills the name and says which command it types", () => {
    const html = renderToStaticMarkup(
      <RenameSessionSheet agent="claude" initialName="Fix the build" paneName="✳ Fix the build" rename={vi.fn()} onClose={vi.fn()} />
    );
    expect(html).toContain('aria-label="Rename session"');
    expect(html).toContain('value="Fix the build"');
    expect(html).toContain("Types /rename &lt;name&gt; into Claude in ✳ Fix the build");
    expect(html).toContain('maxLength="100"');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*type="submit"/);
  });

  it("uses Pi's /name and disables Rename until there is a name", () => {
    const html = renderToStaticMarkup(
      <RenameSessionSheet agent="pi" paneName="π - atwtest" rename={vi.fn()} onClose={vi.fn()} />
    );
    expect(html).toContain("Types /name &lt;name&gt; into Pi");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*type="submit"[^>]*>Rename<\/button>/);
  });
});
