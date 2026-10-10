

    $("#quick").addEventListener("input", () => { worklistSearch?.change(); render(); });
    for (const host of [$('#quick'),$('#filterrow')]) host.addEventListener('keydown',e=>{
      if(e.key==='Enter'&&!e.isComposing&&e.keyCode!==229){e.preventDefault();worklistSearch?.apply();}
    });
    $("#quick-match").addEventListener("change", () => {
      try {
        const next = KinCompoundFilter.withQuickMode(fval[KinCompoundFilter.KEY], $("#quick-match").value, COLS[mode]);
        if (next) fval[KinCompoundFilter.KEY] = next; else delete fval[KinCompoundFilter.KEY];
        activeFilterName = null;
      } catch (error) { toast(error.message, 'err'); }
      worklistSearch?.change();
      render();
    });
    $("#refresh").addEventListener("click", load);
    $('#page-prev').addEventListener('click', () => { resultPage--; render(); });
    $('#page-next').addEventListener('click', () => { resultPage++; render(); });
    $('#page-current').addEventListener('click', () => render(selectedUid));
    $('#page-size').addEventListener('change', () => {
      const size = Number($('#page-size').value);
      if (![25,50,100].includes(size)) return;
      resultPage = Math.floor(resultPage * resultPageSize / size); resultPageSize = size; render();
    });
    $("#m-home").addEventListener("click", load);
    $("#m-filmbox").addEventListener("click", () => { if (selectedUid) openFilmbox(selectedUid); });
