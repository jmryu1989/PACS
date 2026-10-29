

    $('#related-include-current').addEventListener('change',e=>{if(cur()){relatedIncludeCurrent=e.target.checked;renderRelated();}});
    $('#related-body-part').addEventListener('change',e=>{if(cur()){relatedBodyPart=e.target.value;renderRelated();}});
    $('#related-load-parts').addEventListener('click',()=>{if(cur()&&serverMode&&!offline&&!demoMode)relatedParts.load(relatedCandidates().map(x=>x.uid));});
    $('#related-cancel-parts').addEventListener('click',()=>relatedParts.cancel());
    $("#related-return").addEventListener("click", returnToReportStudy);
    // Minhoon item 8: the editor stays on screen in Related Report mode; its Resume Editing is the mode's Back.
    $("#report-editor-resume").addEventListener("click", () => { backToCurrentDraft(); });
    $("#related-modality").addEventListener("change", e => {
      if (!cur()) return;
      // 목록을 좁히는 동작이 현재 영상/판독문을 다시 읽거나 점유를 옮겨서는 안 된다.
      relatedModality = e.target.value;
      renderRelated();
    });
    // W5 (설계 v5 §1.2, slicing W5): a row click opens Related Report mode on that study; images open only by the row's
    // explicit Open/Compare Images button. A double click no longer opens a viewer (two clicks are two row actions).
    $("#relrows").addEventListener("click", e => {
      const open = e.target.closest('[data-related-open]');
      if (open) { openRelatedImages(open.dataset.relatedOpen); return; }
      const tr = e.target.closest("tr");
      if (tr?.dataset.uid) { if(tr.dataset.uid === selectedUid)returnToReportStudy();else relatedActivate(tr.dataset.uid, { focus: true }); }
    });
    function openRelatedImages(uid) {
      if (!cur() || !relatedRows.some(row=>row.uid===uid)) return;
      if(uid===selectedUid)returnToReportStudy();else previewRelated(uid);
      openFilmbox(selectedUid,uid===selectedUid?null:uid);
    }