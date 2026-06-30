    const app = {
      quizEntries: [],
      allQuestionsByQuiz: new Map(),
      currentQuiz: null,
      activeFilter: "all",
      pool: [],
      index: 0,
      score: { correct: 0, wrong: 0 },
      answeredStates: []
    };

    const TYPE_LABEL = {
      single_choice: "Single Choice",
      multiple_choice: "Multiple Choice",
      matching: "Matching",
      ordering: "Ordering",
      short_answer: "Short Answer"
    };

    // Set these if you want to force reports into a specific repository.
    // Leaving them blank enables auto-detection when hosted on GitHub Pages.
    const REPORT_SETTINGS = {
      repoOwner: "",
      repoName: "",
      labels: ["question-report"]
    };

    function normalizeType(typeValue) {
      const safe = String(typeValue || "single_choice").toLowerCase();
      if (safe === "single") return "single_choice";
      if (safe === "multiple") return "multiple_choice";
      return safe;
    }

    function encodePathParts(path) {
      return path
        .split("/")
        .filter(Boolean)
        .map((part) => encodeURIComponent(part))
        .join("/");
    }

    function mapMediaUrl(url, quizPath = "") {
      if (!url) return "";
      if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) {
        return url;
      }

      const baseFolder = quizPath.includes("/")
        ? quizPath.split("/").slice(0, -1).join("/")
        : "";

      if (url.startsWith("./")) {
        const rel = url.slice(2);
        const fullPath = baseFolder ? `${baseFolder}/${rel}` : rel;
        return `questions/${encodePathParts(fullPath)}`;
      }
      if (url.startsWith("images/")) {
        return `questions/${encodePathParts(url)}`;
      }
      if (url.startsWith("questions/")) {
        return url;
      }

      const fullPath = baseFolder ? `${baseFolder}/${url}` : url;
      return `questions/${encodePathParts(fullPath)}`;
    }

    function quizDisplayName(fileName) {
      const match = String(fileName).match(/^week_(\d+)\.json$/i);
      if (match) return `Week ${match[1]}`;
      return String(fileName).replace(/\.json$/i, "");
    }

    function findChoicesForMatching(question) {
      return question.choices || question.descriptions || [];
    }

    function inferRepoFromGitHubPages() {
      const host = window.location.hostname;
      if (!host.endsWith(".github.io")) {
        return null;
      }

      const owner = host.split(".")[0];
      const pathParts = window.location.pathname.split("/").filter(Boolean);
      const repoName = pathParts.length > 0 ? pathParts[0] : `${owner}.github.io`;
      return { owner, repoName };
    }

    function resolveIssueRepo() {
      if (REPORT_SETTINGS.repoOwner && REPORT_SETTINGS.repoName) {
        return { owner: REPORT_SETTINGS.repoOwner, repoName: REPORT_SETTINGS.repoName };
      }
      return inferRepoFromGitHubPages();
    }

    function summarizeAnswerState(question, state) {
      if (!state) return "No response recorded";
      const type = normalizeType(question.type);
      if (type === "single_choice") return `Selected option: ${state.selectedLabel || "none"}`;
      if (type === "multiple_choice") return `Selected options: ${(state.selectedLabels || []).join(", ") || "none"}`;
      if (type === "matching") return `Selected matches: ${JSON.stringify(state.matches || {})}`;
      if (type === "ordering") return `Submitted order: ${(state.order || []).join(" -> ") || "none"}`;
      if (type === "short_answer") return `Short answer response: ${(state.response || "").trim() || "none"}`;
      return "No response summary available";
    }

    function buildIssueBody(question, state, notes) {
      const lines = [
        "## Question Report",
        "",
        `- Quiz: ${app.currentQuiz ? `${app.currentQuiz.subject} / ${app.currentQuiz.displayName}` : "n/a"}`,
        `- Source file: ${app.currentQuiz ? app.currentQuiz.id : "n/a"}`,
        `- Question position: ${app.index + 1} of ${app.pool.length}`,
        `- Question id: ${question.id ?? "n/a"}`,
        `- Type: ${normalizeType(question.type)}`,
        `- Active filter: ${app.activeFilter}`,
        "",
        "### Prompt",
        question.prompt || "",
        "",
        "### Current answer key",
        "```json",
        JSON.stringify(question.answer || {}, null, 2),
        "```",
        "",
        "### My response in quiz",
        summarizeAnswerState(question, state),
        "",
        "### What seems incorrect",
        notes || "(No details entered)",
        ""
      ];
      return lines.join("\n");
    }

    function reportQuestionToGitHub(question, state) {
      const repo = resolveIssueRepo();
      if (!repo) {
        alert(
          "Could not determine your GitHub repository automatically. " +
          "Set REPORT_SETTINGS.repoOwner and REPORT_SETTINGS.repoName in index.html."
        );
        return;
      }

      const notes = window.prompt("Describe what looks incorrect in this question:", "");
      if (notes === null) return;

      const title = `Question issue: ${app.currentQuiz ? app.currentQuiz.displayName : "Unknown"}, Q${question.id ?? app.index + 1}`;
      const body = buildIssueBody(question, state, notes.trim());
      const params = new URLSearchParams({
        title,
        body,
        labels: REPORT_SETTINGS.labels.join(",")
      });
      const issueUrl = `https://github.com/${repo.owner}/${repo.repoName}/issues/new?${params.toString()}`;
      window.location.href = issueUrl;
    }

    function isQuestionCorrect(question, state) {
      const type = normalizeType(question.type);

      if (type === "single_choice") {
        return state.selectedLabel && state.selectedLabel === question.answer?.correct_option;
      }

      if (type === "multiple_choice") {
        const expected = [...(question.answer?.correct_options || [])].sort();
        const picked = [...(state.selectedLabels || [])].sort();
        return expected.length === picked.length && expected.every((v, i) => v === picked[i]);
      }

      if (type === "matching") {
        const expected = question.answer?.matches || [];
        if (!state.matches) return false;
        return expected.every((pair) => state.matches[pair.term_label] === pair.answer_label);
      }

      if (type === "ordering") {
        const expected = question.answer?.order || [];
        const current = state.order || [];
        return expected.length === current.length && expected.every((v, i) => v === current[i]);
      }

      if (type === "short_answer") {
        return state.selfMarked === true;
      }

      return false;
    }

    function renderHub() {
      const grid = document.getElementById("quizGrid");
      const hubStatus = document.getElementById("hubStatus");
      grid.innerHTML = "";

      if (!app.quizEntries.length) {
        hubStatus.textContent = "No quiz files found. Ensure questions/manifest.json points to valid files.";
        return;
      }

      hubStatus.textContent = "Choose a quiz to begin.";

      let totalQuestions = 0;
      const typeSet = new Set();

      const grouped = new Map();
      app.quizEntries.forEach((entry) => {
        const key = `${entry.order}|${entry.subject}`;
        if (!grouped.has(key)) {
          grouped.set(key, { order: entry.order, subject: entry.subject, items: [] });
        }
        grouped.get(key).items.push(entry);
      });

      const sections = [...grouped.values()]
        .sort((a, b) => (a.order - b.order) || a.subject.localeCompare(b.subject));

      sections.forEach((section) => {
        section.items.sort((a, b) => a.fileName.localeCompare(b.fileName));

        const sectionEl = document.createElement("div");
        sectionEl.className = "subject-section";

        const heading = document.createElement("h2");
        heading.className = "subject-title";
        heading.textContent = section.subject;
        sectionEl.appendChild(heading);

        const sectionGrid = document.createElement("div");
        sectionGrid.className = "subject-quiz-row";

        section.items.forEach((entry) => {
          const qList = app.allQuestionsByQuiz.get(entry.id) || [];
          totalQuestions += qList.length;
          qList.forEach((q) => typeSet.add(normalizeType(q.type)));

          const card = document.createElement("button");
          card.className = "card";
          card.type = "button";
          card.innerHTML = `
            <h3>${entry.displayName}</h3>
            <div class="sub">${qList.length} questions</div>
          `;
          card.addEventListener("click", () => openQuiz(entry.id));
          sectionGrid.appendChild(card);
        });

        sectionEl.appendChild(sectionGrid);
        grid.appendChild(sectionEl);
      });

      document.getElementById("totalQuizzesPill").textContent = `Quizzes: ${app.quizEntries.length}`;
      document.getElementById("totalQuestionsPill").textContent = `Questions: ${totalQuestions}`;
    }

    function resetQuizState() {
      app.index = 0;
      app.score.correct = 0;
      app.score.wrong = 0;
      app.answeredStates = [];
      document.getElementById("correctCount").textContent = "0";
      document.getElementById("wrongCount").textContent = "0";
    }

    function getFilterOptions() {
      const set = new Set(["all"]);
      const current = app.currentQuiz ? app.allQuestionsByQuiz.get(app.currentQuiz.id) : [];
      (current || []).forEach((q) => set.add(normalizeType(q.type)));
      return [...set];
    }

    function applyFilter() {
      const all = app.currentQuiz ? (app.allQuestionsByQuiz.get(app.currentQuiz.id) || []) : [];
      app.pool = app.activeFilter === "all"
        ? [...all]
        : all.filter((q) => normalizeType(q.type) === app.activeFilter);
      resetQuizState();
      renderFilters();
      renderQuestion();
    }

    function renderFilters() {
      const mount = document.getElementById("filters");
      const opts = getFilterOptions();
      mount.innerHTML = opts
        .map((opt) => {
          const label = opt === "all" ? "All" : (TYPE_LABEL[opt] || opt);
          const on = app.activeFilter === opt ? "on" : "";
          return `<button type="button" class="fbtn ${on}" data-filter="${opt}">${label}</button>`;
        })
        .join("");

      mount.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", () => {
          app.activeFilter = btn.dataset.filter;
          applyFilter();
        });
      });
    }

    function shuffleCurrentPool() {
      for (let i = app.pool.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = app.pool[i];
        app.pool[i] = app.pool[j];
        app.pool[j] = tmp;
      }
      resetQuizState();
      renderQuestion();
    }

    function updateTopStats() {
      document.getElementById("qTotal").textContent = String(app.pool.length);
      document.getElementById("qIndex").textContent = app.pool.length ? String(app.index + 1) : "0";
      document.getElementById("correctCount").textContent = String(app.score.correct);
      document.getElementById("wrongCount").textContent = String(app.score.wrong);
      const pct = app.pool.length ? (app.index / app.pool.length) * 100 : 0;
      document.getElementById("progressBar").style.width = `${Math.min(100, pct)}%`;
    }

    function renderQuestion() {
      const mount = document.getElementById("quizMount");
      updateTopStats();

      if (!app.pool.length) {
        mount.innerHTML = '<div class="result">No questions in this filter.</div>';
        return;
      }

      if (app.index >= app.pool.length) {
        const pct = Math.round((app.score.correct / app.pool.length) * 100);
        document.getElementById("progressBar").style.width = "100%";
        mount.innerHTML = `
          <div class="result">
            <h3 style="margin:0 0 8px;">Quiz Complete</h3>
            <p style="margin:0 0 12px;">Score: <span class="ok">${app.score.correct}</span> / ${app.pool.length} (${pct}%)</p>
            <button class="btn primary" id="restartDoneBtn">Restart</button>
          </div>
        `;
        document.getElementById("restartDoneBtn").addEventListener("click", applyFilter);
        return;
      }

      const question = app.pool[app.index];
      const type = normalizeType(question.type);
      const answerState = app.answeredStates[app.index];
      const prompt = question.prompt || "";
      const media = question.media && question.media.type === "image"
        ? `<img class="q-media" src="${mapMediaUrl(question.media.url, app.currentQuiz ? app.currentQuiz.id : "")}" alt="Question media" />`
        : "";

      mount.innerHTML = `
        <div class="q-card">
          <div class="q-top">
            <span class="q-type">${TYPE_LABEL[type] || type}</span>
            <button type="button" class="btn report-btn" id="reportBtn">Report Question</button>
          </div>
          <p class="q-prompt">${escapeHtml(prompt)}</p>
          ${media}
          <div id="answerMount"></div>
          <div id="explainMount"></div>
          <div class="nav hidden" id="nextNav">
            <button class="btn primary" id="nextBtn">Next Question</button>
          </div>
        </div>
      `;

      document.getElementById("reportBtn").addEventListener("click", () => {
        reportQuestionToGitHub(question, answerState);
      });

      const answerMount = document.getElementById("answerMount");

      if (type === "single_choice") {
        renderSingleChoice(answerMount, question, answerState);
      } else if (type === "multiple_choice") {
        renderMultipleChoice(answerMount, question, answerState);
      } else if (type === "matching") {
        renderMatching(answerMount, question, answerState);
      } else if (type === "ordering") {
        renderOrdering(answerMount, question, answerState);
      } else if (type === "short_answer") {
        renderShortAnswer(answerMount, question, answerState);
      } else {
        answerMount.innerHTML = `<p style="color:#a23434;">Unsupported question type: ${escapeHtml(type)}</p>`;
      }

      document.getElementById("nextBtn").addEventListener("click", () => {
        app.index += 1;
        renderQuestion();
      });
    }

    function renderExplanation(question, state) {
      const expMount = document.getElementById("explainMount");
      const nextNav = document.getElementById("nextNav");
      const explanation =
        question.answer?.explanation ||
        (question.answer?.text ? `Reference answer: ${question.answer.text}` : "");

      if (explanation) {
        expMount.innerHTML = `<div class="exp"><h4>Explanation</h4>${escapeHtml(explanation)}</div>`;
      } else {
        expMount.innerHTML = "";
      }

      if (state && state.graded) {
        nextNav.classList.remove("hidden");
      }
    }

    function gradeAndStore(question, state) {
      if (state.graded) return;
      state.graded = true;
      const ok = isQuestionCorrect(question, state);
      if (ok) app.score.correct += 1;
      else app.score.wrong += 1;
      app.answeredStates[app.index] = state;
      updateTopStats();
      renderExplanation(question, state);
    }

    function renderSingleChoice(mount, question, state) {
      const st = state || { graded: false, selectedLabel: null };
      const options = question.options || [];

      mount.innerHTML = `
        <div class="opt-list" id="singleList">
          ${options.map((o) => {
            const selected = st.selectedLabel === o.label;
            let cls = "opt";
            if (st.graded && o.label === question.answer?.correct_option) cls += " good";
            if (st.graded && selected && o.label !== question.answer?.correct_option) cls += " bad";
            return `
              <button type="button" class="${cls}" data-label="${escapeHtml(o.label)}" ${st.graded ? "disabled" : ""}>
                <span class="lbl">${escapeHtml(o.label)}.</span>
                <span>${escapeHtml(o.text || "")}</span>
              </button>
            `;
          }).join("")}
        </div>
      `;

      mount.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (st.graded) return;
          st.selectedLabel = btn.dataset.label;
          gradeAndStore(question, st);
          renderQuestion();
        });
      });

      if (st.graded) {
        renderExplanation(question, st);
        document.getElementById("nextNav").classList.remove("hidden");
      }
    }

    function renderMultipleChoice(mount, question, state) {
      const st = state || { graded: false, selectedLabels: [] };
      const options = question.options || [];

      mount.innerHTML = `
        <div class="opt-list">
          ${options.map((o) => {
            const checked = st.selectedLabels.includes(o.label);
            const isCorrect = (question.answer?.correct_options || []).includes(o.label);
            let cls = "opt";
            if (st.graded && isCorrect) cls += " good";
            if (st.graded && checked && !isCorrect) cls += " bad";
            return `
              <label class="${cls}${st.graded ? " locked" : ""}">
                <input type="checkbox" data-label="${escapeHtml(o.label)}" ${checked ? "checked" : ""} ${st.graded ? "disabled" : ""} />
                <span class="lbl">${escapeHtml(o.label)}.</span>
                <span>${escapeHtml(o.text || "")}</span>
              </label>
            `;
          }).join("")}
        </div>
        <button class="btn primary" id="submitMcq" ${st.graded ? "disabled" : ""}>Submit Answer</button>
      `;

      mount.querySelectorAll("input[type='checkbox']").forEach((cb) => {
        cb.addEventListener("change", () => {
          st.selectedLabels = [...mount.querySelectorAll("input[type='checkbox']:checked")].map((x) => x.dataset.label);
        });
      });

      document.getElementById("submitMcq").addEventListener("click", () => {
        if (st.graded) return;
        st.selectedLabels = [...mount.querySelectorAll("input[type='checkbox']:checked")].map((x) => x.dataset.label);
        gradeAndStore(question, st);
        renderQuestion();
      });

      if (st.graded) {
        renderExplanation(question, st);
        document.getElementById("nextNav").classList.remove("hidden");
      }
    }

    function renderMatching(mount, question, state) {
      const terms = question.terms || [];
      const choices = findChoicesForMatching(question);
      const st = state || { graded: false, matches: {} };

      const optionsHtml = ['<option value="">Select</option>']
        .concat(choices.map((c) => `<option value="${escapeHtml(c.label)}">${escapeHtml(c.label)}. ${escapeHtml(c.text || "")}</option>`))
        .join("");

      mount.innerHTML = `
        <div>
          ${terms.map((term) => `
            <div class="match-row">
              <div><strong>${escapeHtml(term.label)}.</strong> ${escapeHtml(term.text || "")}</div>
              <select data-term="${escapeHtml(term.label)}" ${st.graded ? "disabled" : ""}>${optionsHtml}</select>
            </div>
          `).join("")}
        </div>
        <button class="btn primary" id="submitMatch" ${st.graded ? "disabled" : ""}>Submit Matching</button>
      `;

      mount.querySelectorAll("select").forEach((sel) => {
        const termLabel = sel.dataset.term;
        if (st.matches[termLabel]) {
          sel.value = st.matches[termLabel];
        }
        sel.addEventListener("change", () => {
          st.matches[termLabel] = sel.value;
        });
      });

      document.getElementById("submitMatch").addEventListener("click", () => {
        if (st.graded) return;
        mount.querySelectorAll("select").forEach((sel) => {
          st.matches[sel.dataset.term] = sel.value;
        });
        gradeAndStore(question, st);
        renderQuestion();
      });

      if (st.graded) {
        renderExplanation(question, st);
        document.getElementById("nextNav").classList.remove("hidden");
      }
    }

    function renderOrdering(mount, question, state) {
      const options = question.options || [];
      const initialOrder = options.map((o) => o.label);
      const st = state || { graded: false, order: [...initialOrder] };

      function itemByLabel(label) {
        return options.find((o) => o.label === label) || { label, text: label };
      }

      function redraw() {
        mount.innerHTML = `
          <div class="order-list">
            ${st.order.map((label, i) => {
              const item = itemByLabel(label);
              return `
                <div class="order-row">
                  <div><strong>${i + 1}.</strong> ${escapeHtml(item.label)}. ${escapeHtml(item.text || "")}</div>
                  <div class="order-actions">
                    <button type="button" class="mini" data-move="up" data-idx="${i}" ${st.graded || i === 0 ? "disabled" : ""}>Up</button>
                    <button type="button" class="mini" data-move="down" data-idx="${i}" ${st.graded || i === st.order.length - 1 ? "disabled" : ""}>Down</button>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
          <button class="btn primary" id="submitOrder" ${st.graded ? "disabled" : ""}>Submit Order</button>
        `;

        mount.querySelectorAll("button[data-move]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const idx = Number(btn.dataset.idx);
            const dir = btn.dataset.move;
            if (dir === "up" && idx > 0) {
              [st.order[idx - 1], st.order[idx]] = [st.order[idx], st.order[idx - 1]];
            }
            if (dir === "down" && idx < st.order.length - 1) {
              [st.order[idx + 1], st.order[idx]] = [st.order[idx], st.order[idx + 1]];
            }
            redraw();
          });
        });

        document.getElementById("submitOrder").addEventListener("click", () => {
          if (st.graded) return;
          gradeAndStore(question, st);
          renderQuestion();
        });
      }

      redraw();

      if (st.graded) {
        renderExplanation(question, st);
        document.getElementById("nextNav").classList.remove("hidden");
      }
    }

    function renderShortAnswer(mount, question, state) {
      const st = state || { graded: false, response: "", selfMarked: null };

      const refText = question.answer?.text || "";

      mount.innerHTML = `
        <textarea id="shortAnsInput" placeholder="Type your answer here..." ${st.graded ? "disabled" : ""}>${escapeHtml(st.response || "")}</textarea>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn primary" id="revealShortBtn" ${st.graded ? "disabled" : ""}>Reveal Reference Answer</button>
        </div>
        <div id="shortReviewMount"></div>
      `;

      const input = document.getElementById("shortAnsInput");
      input.addEventListener("input", () => {
        st.response = input.value;
      });

      document.getElementById("revealShortBtn").addEventListener("click", () => {
        if (st.graded) return;
        const review = document.getElementById("shortReviewMount");
        review.innerHTML = `
          <div class="exp" style="margin-bottom:10px;"><h4>Reference Answer</h4>${escapeHtml(refText || "No reference answer provided.")}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn" id="selfGood">I got this correct</button>
            <button class="btn" id="selfBad">I missed this</button>
          </div>
        `;

        document.getElementById("selfGood").addEventListener("click", () => {
          st.selfMarked = true;
          gradeAndStore(question, st);
          renderQuestion();
        });

        document.getElementById("selfBad").addEventListener("click", () => {
          st.selfMarked = false;
          gradeAndStore(question, st);
          renderQuestion();
        });
      });

      if (st.graded) {
        renderExplanation(question, st);
        document.getElementById("nextNav").classList.remove("hidden");
      }
    }

    function openQuiz(quizId) {
      app.currentQuiz = app.quizEntries.find((entry) => entry.id === quizId) || null;
      app.activeFilter = "all";

      const fullList = app.currentQuiz ? (app.allQuestionsByQuiz.get(app.currentQuiz.id) || []) : [];
      document.getElementById("quizTitle").textContent = `${app.currentQuiz ? app.currentQuiz.displayName : "Quiz"} Quiz`;
      document.getElementById("quizSubtitle").textContent = app.currentQuiz
        ? `${fullList.length} questions loaded from questions/${app.currentQuiz.id}`
        : "";

      applyFilter();

      document.getElementById("hubView").style.display = "none";
      document.getElementById("quizView").style.display = "block";
      window.scrollTo({ top: 0, behavior: "auto" });
    }

    function closeQuiz() {
      document.getElementById("quizView").style.display = "none";
      document.getElementById("hubView").style.display = "block";
      window.scrollTo({ top: 0, behavior: "auto" });
    }

    async function loadQuizFile(folder, fileName) {
      const path = `questions/${encodeURIComponent(folder)}/${encodeURIComponent(fileName)}`;
      try {
        const res = await fetch(path, { cache: "no-store" });
        if (!res.ok) {
          return null;
        }
        const body = await res.json();
        const questions = Array.isArray(body.questions) ? body.questions : [];
        return { questions };
      } catch (_) {
        return null;
      }
    }

    async function loadManifest() {
      try {
        const res = await fetch("questions/manifest.json", { cache: "no-store" });
        if (!res.ok) return null;
        return await res.json();
      } catch (_) {
        return null;
      }
    }

    async function loadAllQuizzes() {
      const loadingText = document.getElementById("hubStatus");
      loadingText.textContent = "Scanning question files...";

      const manifest = await loadManifest();
      const subjects = Array.isArray(manifest?.subjects) ? manifest.subjects : [];

      for (const subject of subjects) {
        const folder = String(subject.folder || "").trim();
        if (!folder) continue;

        const subjectName = String(subject.subject || folder.split("-").slice(1).join("-") || folder).trim();
        const order = Number.isFinite(Number(subject.order)) ? Number(subject.order) : Number(folder.split("-")[0]) || 999;
        const files = (Array.isArray(subject.files) ? [...subject.files] : [])
          .filter((name) => String(name).toLowerCase().endsWith(".json"))
          .sort((a, b) => String(a).localeCompare(String(b)));

        for (const fileNameRaw of files) {
          const fileName = String(fileNameRaw);
          const payload = await loadQuizFile(folder, fileName);
          if (!payload) continue;

          const id = `${folder}/${fileName}`;
          app.quizEntries.push({
            id,
            folder,
            fileName,
            subject: subjectName,
            order,
            displayName: quizDisplayName(fileName)
          });
          app.allQuestionsByQuiz.set(id, payload.questions);
        }
      }

      app.quizEntries.sort((a, b) =>
        (a.order - b.order) ||
        a.subject.localeCompare(b.subject) ||
        a.fileName.localeCompare(b.fileName)
      );

      renderHub();
    }

    function escapeHtml(input) {
      return String(input)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    document.getElementById("backBtn").addEventListener("click", closeQuiz);
    document.getElementById("shuffleBtn").addEventListener("click", shuffleCurrentPool);
    document.getElementById("restartBtn").addEventListener("click", applyFilter);

    loadAllQuizzes();
