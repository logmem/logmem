// docs.js — Interactive Documentation & Walkthrough Scripts
document.addEventListener("DOMContentLoaded", () => {
  // 1. Persona Tab Switching
  document.querySelectorAll(".persona-group").forEach((group) => {
    const tabs = group.querySelectorAll(".persona-tab");
    const panels = group.querySelectorAll(".persona-panel");

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = tab.getAttribute("data-target");

        tabs.forEach((t) => t.classList.remove("active"));
        panels.forEach((p) => p.classList.remove("active"));

        tab.classList.add("active");
        const panel = group.querySelector(`#${target}`);
        if (panel) panel.classList.add("active");
      });
    });
  });

  // 2. Copy Code Buttons
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const targetId = btn.getAttribute("data-copy");
      const el = document.getElementById(targetId);
      if (!el) return;

      const text = el.innerText || el.textContent;
      try {
        await navigator.clipboard.writeText(text);
        const original = btn.innerHTML;
        btn.innerHTML = `<span class="lm-muted">Copied!</span>`;
        setTimeout(() => {
          btn.innerHTML = original;
        }, 1800);
      } catch (err) {
        console.error("Copy failed", err);
      }
    });
  });

  // 3. Tool Search / Filter
  const searchInput = document.getElementById("tool-search");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      const q = e.target.value.toLowerCase().trim();
      const cards = document.querySelectorAll(".tool-card");

      cards.forEach((card) => {
        const name = (card.getAttribute("data-tool") || "").toLowerCase();
        const desc = (card.querySelector(".tool-desc")?.innerText || "").toLowerCase();
        const category = (card.getAttribute("data-category") || "").toLowerCase();

        const match = !q || name.includes(q) || desc.includes(q) || category.includes(q);
        card.style.display = match ? "block" : "none";
      });
    });
  }

  // 4. Active Rail Link Tracking via IntersectionObserver
  const sections = document.querySelectorAll(".docs-section");
  const navLinks = document.querySelectorAll(".docs-nav-link");

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const id = entry.target.getAttribute("id");
          navLinks.forEach((link) => {
            if (link.getAttribute("href") === `#${id}`) {
              link.classList.add("active");
            } else {
              link.classList.remove("active");
            }
          });
        }
      });
    },
    { rootMargin: "-20% 0px -70% 0px" }
  );

  sections.forEach((s) => observer.observe(s));
});
