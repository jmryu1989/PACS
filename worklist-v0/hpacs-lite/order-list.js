

    // ══════════ Order List (8.2.2) ══════════
    const ofval = {};
    $(".order-p .filters").addEventListener("input", e => {
      const el = e.target.closest("[data-o]"); if (!el) return;
      ofval[el.dataset.o] = el.value.trim().toUpperCase();
      renderOrders();
    });

    /**
     * Add-on conditions on the Order List (the Technician order search; feature-mounts.js orders.filter): each is asked
     * with a copy of one order and keeps it when it answers true, together with the panel's own ID / Name / Modality /
     * StudyDesc boxes and ID sync. With none the list is exactly what it was.
     */
    const orderAddOnFilters = new Set();
    function filteredOrders() {
      const s = cur();
      return orders.filter(o => {
        if ($("#o-sync").checked && s && o.id !== s.id) return false;
        if (!Object.entries(ofval).every(([k, v]) => !v || String(o[k] ?? "").toUpperCase().includes(v))) return false;
        for (const keep of orderAddOnFilters) {
          try { if (!keep({ ...o })) return false; } catch (error) { console.error('Order List add-on filter failed', error); }
        }
        return true;
      });
    }

    function renderOrders() {
      if (mode !== "Technician") return;
      const list = filteredOrders();
      $("#orderrows").innerHTML = list.map((o, i) => `
        <tr data-oid="${esc(o.oid)}" class="${o.oid === selectedOid ? "sel" : ""}">
          <td class="num">${i + 1}</td>
          <td><span class="mt ${esc(o.matched)}">${esc(o.matched)}</span></td>
          <td>${esc(o.id)}</td><td>${esc(o.name)}</td><td>${esc(o.sex)}</td><td>${esc(o.birth)}</td>
          <td>${esc(o.sched)}</td><td>${esc(o.modality)}</td><td>${esc(o.desc)}</td><td>${esc(o.ward)}</td><td>${esc(o.reqDoc)}</td>
        </tr>`).join("") || `<tr><td class="empty" colspan="11">오더 없음</td></tr>`;

      const s = cur(), o = curOrder();
      $("#orderhint").textContent =
        `선택: 검사 ${s ? s.name + " / " + s.date : "(없음)"}  ·  오더 ${o ? o.name + " / " + o.sched : "(없음)"}` +
        (s && o && s.matched === "U" && o.matched === "U" ? "  → 우클릭 Match 가능" : "");
      notifyAddOns("orders", [list.length]);
    }
    $("#orderrows").addEventListener("click", e => {
      const tr = e.target.closest("tr[data-oid]"); if (!tr) return;
      selectedOid = tr.dataset.oid;
      renderOrders();
    });
    $("#o-sync").addEventListener("change", renderOrders);
    /**
     * S4-U5 Order List refresh. The server list is read through the existing guarded bootstrap read (own institution,
     * access-filtered); only the latest answer for this account's institution replaces it, and the selected order stays
     * selected while it is still listed. Without a server this only redraws, as before. Answers true when this read
     * replaced the list (the Technician windows tell a confirmed result from one they could not read back).
     */
    async function refreshOrders() {
      if (!serverMode) { renderOrders(); return true; }
      const token = ++orderRefreshSequence;
      let answer = null;
      const at = work.capture("document");
      try { answer = await api("GET", "/bootstrap?states=omit", undefined, undefined, at); } catch (e) { answer = null; }
      let replaced = false;
      work.commit(at, () => {
        if (token !== orderRefreshSequence || !serverMode) return;
        if (!Array.isArray(answer?.orders) || !myInstitution || answer.me?.institution !== myInstitution) {
          toast("오더 목록을 다시 받지 못했습니다 — 보이는 목록은 이전 것입니다. 잠시 후 Refresh를 다시 누르세요.", "err");
          return;
        }
        orders = answer.orders;
        if (!orders.some(o => o.oid === selectedOid)) selectedOid = null;
        renderOrders();
        replaced = true;
      });
      return replaced;
    }
    $("#o-refresh").addEventListener("click", refreshOrders);
    $("#o-clear").addEventListener("click", () => {
      Object.keys(ofval).forEach(k => ofval[k] = "");
      document.querySelectorAll(".order-p .filters input").forEach(i => i.value = "");
      $("#o-sync").checked = false;
      renderOrders();
    });