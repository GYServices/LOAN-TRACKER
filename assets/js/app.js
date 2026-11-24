
  import { firebaseConfig, ADMIN_EMAIL, ADMIN_UID } from "./firebase-config.js";
 
  import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
  import {
    getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
    EmailAuthProvider, reauthenticateWithCredential
  } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
 
  import {
    getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, setDoc, getDoc,
    onSnapshot, query, orderBy, runTransaction, serverTimestamp, deleteField
  } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
 
  const $ = id => document.getElementById(id);
 
  const money = value => "₦" + Number(value || 0).toLocaleString("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
 
  const number = value => Number(value || 0);
 
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  })[c]);
 
  const dateText = value => value
    ? new Date(value + (String(value).length === 10 ? "T00:00:00" : "")).toLocaleDateString("en-NG")
    : "—";
 
  const statuses = ["Active","Fully Paid","Overdue","Defaulted","Long Overdue"];
 
  const statusClass = status => ({
    "Active":"status-active",
    "Fully Paid":"status-paid",
    "Overdue":"status-overdue",
    "Defaulted":"status-defaulted",
    "Long Overdue":"status-long"
  }[status] || "status-active");
 
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
 
  let currentUser = null;
  let currentPage = "dashboard";
  let loans = [];
  let payments = [];
  let unsubLoans = null;
  let unsubPayments = null;
  const migratedLegacyLoanIds = new Set();
 
  const userCollection = name =>
    collection(db, "users", currentUser.uid, name);
 
  const userDoc = (name, id) =>
    doc(db, "users", currentUser.uid, name, id);
 
  // Highly sensitive identity/banking fields live in a separate collection.
  // They are never included in ordinary loan cards or dashboard summaries.
  const sensitiveFields = ["nin", "bvn", "accountNoBank", "guarantorNin"];
  const sensitiveDoc = id => doc(db, "users", currentUser.uid, "sensitiveLoans", id);
 
  function masked(value) {
    const raw = String(value || "").trim();
    if (!raw) return "Not provided";
    if (raw.length <= 4) return "••••";
    return "••••••" + raw.slice(-4);
  }
 
  async function confirmAdminPassword() {
    const password = prompt("For your protection, re-enter the administrator password to reveal sensitive details:");
    if (password === null) return false;
    if (!password.trim()) {
      showToast("Password is required to reveal sensitive details.", "error");
      return false;
    }
    try {
      const credential = EmailAuthProvider.credential(ADMIN_EMAIL, password);
      await reauthenticateWithCredential(auth.currentUser, credential);
      return true;
    } catch (error) {
      showToast("Password confirmation failed. Sensitive details remain hidden.", "error");
      return false;
    }
  }
 
  async function viewSensitiveDetails(loanId) {
    const loan = loans.find(item => item.id === loanId);
    if (!loan) return;
    if (!(await confirmAdminPassword())) return;
 
    try {
      const snap = await getDoc(sensitiveDoc(loanId));
      const saved = snap.exists() ? snap.data() : {};
      // Legacy records may still have these values on the original loan document.
      const values = {};
      sensitiveFields.forEach(key => values[key] = saved[key] || loan[key] || "");
      const labels = {
        nin: "Borrower NIN",
        bvn: "Borrower BVN",
        accountNoBank: "Account Number / Bank",
        guarantorNin: "Guarantor NIN"
      };
      const rows = sensitiveFields.map(key => `
        <div class="break-row">
          <span>${labels[key]}</span>
          <strong class="sensitive-value">${esc(values[key] || "Not provided")}</strong>
        </div>`).join("");
 
      $("modalRoot").innerHTML = `
        <div class="modal-backdrop" id="modalBackdrop">
          <section class="modal narrow" role="dialog" aria-modal="true">
            <div class="modal-head">
              <h3>Protected details · Loan #${esc(loan.loanNumber || "—")}</h3>
              <button class="close" type="button" data-close-modal>×</button>
            </div>
            <div class="modal-body">
              <div class="sensitive-note">These details are confidential. Do not share screenshots or leave this screen visible to others.</div>
              <div class="breakdown">${rows}</div>
            </div>
            <div class="modal-foot">
              <button class="btn primary" type="button" data-close-modal>Close</button>
            </div>
          </section>
        </div>`;
      bindModalClose();
    } catch (error) {
      showToast(friendlyError(error), "error");
    }
  }
 
  function showToast(message, type = "success-toast") {
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = message;
    $("toastWrap").appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }
 
  function setBusy(button, busy, label = "Saving…") {
    if (!button) return;
    if (busy) {
      button.dataset.oldText = button.innerHTML;
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span>' + label;
    } else {
      button.disabled = false;
      button.innerHTML = button.dataset.oldText || "Save";
    }
  }
 
  function calcLoan(principal, rate, duration) {
    const interest = principal * (rate / 100) * duration;
    const payable = principal + interest;
    return {
      interest,
      payable,
      monthly: duration > 0 ? payable / duration : 0
    };
  }
 
  function paidFor(loanId) {
    return payments
      .filter(p => p.loanId === loanId)
      .reduce((sum,p) => sum + number(p.amount), 0);
  }
 
  function outstandingFor(loan) {
    return Math.max(0, number(loan.totalPayable) - paidFor(loan.id));
  }
 
  function effectiveStatus(loan) {
    if (paidFor(loan.id) >= number(loan.totalPayable) && number(loan.totalPayable) > 0) {
      return "Fully Paid";
    }
    return loan.status === "Fully Paid"
      ? (loan.statusBeforePaid || "Active")
      : (loan.status || "Active");
  }
 
  function friendlyError(error) {
    const messages = {
      "auth/email-already-in-use":"This email already has an account.",
      "auth/invalid-credential":"Email or password is incorrect.",
      "auth/weak-password":"Password must contain at least 6 characters.",
      "auth/invalid-email":"Please enter a valid email address.",
      "auth/network-request-failed":"Check your internet connection.",
      "permission-denied":"Access denied. Check your Firestore security rules."
    };
 
    return messages[error?.code] || error?.message || "Something went wrong.";
  }
 
  function stopListeners() {
    if (unsubLoans) unsubLoans();
    if (unsubPayments) unsubPayments();
    unsubLoans = null;
    unsubPayments = null;
  }
 
  async function migrateLegacySensitiveRecords(documents) {
    for (const loanSnap of documents) {
      const legacy = loanSnap.data();
      const hasLegacySensitive = sensitiveFields.some(key =>
        Object.prototype.hasOwnProperty.call(legacy, key) && legacy[key]
      );
      if (!hasLegacySensitive || migratedLegacyLoanIds.has(loanSnap.id)) continue;
 
      migratedLegacyLoanIds.add(loanSnap.id);
      const protectedData = {};
      const cleanup = {};
      sensitiveFields.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(legacy, key)) {
          protectedData[key] = legacy[key] || "";
          cleanup[key] = deleteField();
        }
      });
 
      try {
        await setDoc(sensitiveDoc(loanSnap.id), {
          ...protectedData,
          migratedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }, {merge:true});
        await updateDoc(userDoc("loans", loanSnap.id), cleanup);
      } catch (error) {
        migratedLegacyLoanIds.delete(loanSnap.id);
        showToast("A legacy protected record could not be moved. Check Firestore permissions and try again.", "error");
      }
    }
  }
 
  function startListeners() {
    stopListeners();
 
    $("loadingCover").classList.remove("hidden");
 
    unsubLoans = onSnapshot(
      query(userCollection("loans"), orderBy("createdAt","desc")),
      snap => {
        loans = snap.docs.map(d => ({id:d.id,...d.data()}));
        render();
        $("loadingCover").classList.add("hidden");
        migrateLegacySensitiveRecords(snap.docs);
      },
      error => {
        $("loadingCover").classList.add("hidden");
        showToast(friendlyError(error),"error");
      }
    );
 
    unsubPayments = onSnapshot(
      query(userCollection("payments"), orderBy("date","desc")),
      snap => {
        payments = snap.docs.map(d => ({id:d.id,...d.data()}));
        render();
      },
      error => showToast(friendlyError(error),"error")
    );
  }
 
  function showAuth() {
    $("authScreen").classList.remove("hidden");
    $("appShell").classList.add("hidden");
  }
 
  function showApp() {
    $("authScreen").classList.add("hidden");
    $("appShell").classList.remove("hidden");
    $("userEmail").textContent = currentUser.email || "";
  }
 
  $("authForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = $("authSubmit");
    setBusy(button,true,"Please wait…");
 
    try {
      const password = $("authPassword").value;
      const credential = await signInWithEmailAndPassword(auth, ADMIN_EMAIL, password);
      if (credential.user.uid !== ADMIN_UID) {
        await signOut(auth);
        throw new Error("This account is not authorised to access G & Y Services Loan Tracker.");
      }
      $("authPassword").value = "";
      showToast("Administrator authentication successful.");
    } catch (error) {
      showToast(friendlyError(error),"error");
    } finally {
      setBusy(button,false);
    }
  });
 
  $("logoutBtn").addEventListener("click", async () => {
    try {
      await signOut(auth);
    } catch(error) {
      showToast(friendlyError(error),"error");
    }
  });
 
  onAuthStateChanged(auth, async user => {
    if (user && user.uid !== ADMIN_UID) {
      currentUser = null;
      stopListeners();
      loans = [];
      payments = [];
      showAuth();
      try { await signOut(auth); } catch (error) {
        showToast("Unauthorised account. Please sign in with the administrator password.", "error");
      }
      return;
    }
    currentUser = user;
    if (user) {
      showApp();
      startListeners();
    } else {
      stopListeners();
      loans = [];
      payments = [];
      showAuth();
    }
  });
 
  document.querySelectorAll(".nav-item").forEach(button => {
    button.addEventListener("click", () => navigate(button.dataset.page));
  });
 
  function navigate(page) {
    currentPage = page;
 
    document.querySelectorAll(".nav-item").forEach(button => {
      button.classList.toggle("active",button.dataset.page === page);
    });
 
    $("pageSubTitle").textContent =
      "Loan Tracker · " + page.charAt(0).toUpperCase() + page.slice(1);
 
    render();
  }
 
  function pageHeader(title,subtitle,action="") {
    return `<div class="page-heading">
      <div><h2>${title}</h2><p>${subtitle}</p></div>${action}
    </div>`;
  }
 
  function stat(label,value,isMoney=false) {
    return `<div class="stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value ${isMoney?"money":""}">${value}</div>
    </div>`;
  }
 
  function renderDashboard() {
    const principal = loans.reduce((s,l)=>s+number(l.principal),0);
    const interest = loans.reduce((s,l)=>s+number(l.totalInterest),0);
    const payable = loans.reduce((s,l)=>s+number(l.totalPayable),0);
    const paid = payments.reduce((s,p)=>s+number(p.amount),0);
    const outstanding = loans.reduce((s,l)=>s+outstandingFor(l),0);
 
    const count = status =>
      loans.filter(l=>effectiveStatus(l)===status).length;
 
    const active = count("Active") + count("Overdue") +
      count("Defaulted") + count("Long Overdue");
 
    return pageHeader(
      "Dashboard",
      "A live overview of your loan portfolio.",
      '<button class="btn success" id="dashboardNewLoanBtn" type="button">＋ New Loan</button>'
    ) +
      `<div class="stats-grid">
        ${stat("Total Loans",loans.length)}
        ${stat("Total Principal Lent",money(principal),true)}
        ${stat("Total Interest",money(interest),true)}
        ${stat("Total Payable",money(payable),true)}
        ${stat("Total Amount Paid",money(paid),true)}
        ${stat("Outstanding Balance",money(outstanding),true)}
        ${stat("Active Loans",active)}
        ${stat("Fully Paid Loans",count("Fully Paid"))}
      </div>
      <div class="dashboard-lower">
        <section class="panel">
          <h3>Loan Status Breakdown</h3>
          <div class="breakdown">
            ${statuses.map(s=>`
              <div class="break-row">
                <span class="break-left">
                  <i class="dot" style="background:${({
                    Active:"#00B050",
                    "Fully Paid":"#2e6bd1",
                    Overdue:"#e6a23c",
                    Defaulted:"#d92d20",
                    "Long Overdue":"#7a271a"
                  })[s]}"></i>${s}
                </span>
                <span class="break-count">${count(s)}</span>
              </div>
            `).join("")}
          </div>
        </section>
        <section class="panel">
          <h3>Portfolio at a glance</h3>
          <div class="breakdown">
            <div class="break-row"><span>Recorded payments</span><strong>${payments.length}</strong></div>
            <div class="break-row"><span>Average loan size</span><strong>${money(loans.length?principal/loans.length:0)}</strong></div>
            <div class="break-row"><span>Collection rate</span><strong>${payable?(paid/payable*100).toFixed(1):"0.0"}%</strong></div>
          </div>
        </section>
      </div>`;
  }
 
  function loanCard(loan) {
    const paid = paidFor(loan.id);
    const balance = outstandingFor(loan);
    const status = effectiveStatus(loan);
 
    return `<article class="loan-card">
      <div class="card-top">
        <div>
          <div class="loan-id">LOAN #${esc(loan.loanNumber||"—")}</div>
          <div class="borrower">${esc(loan.fullName)}</div>
        </div>
        <span class="badge ${statusClass(status)}">${esc(status)}</span>
      </div>
 
      <div class="loan-metrics">
        <div><div class="metric-label">Principal</div><div class="metric-value">${money(loan.principal)}</div></div>
        <div><div class="metric-label">Interest rate</div><div class="metric-value">${number(loan.rate)}%</div></div>
        <div><div class="metric-label">Duration</div><div class="metric-value">${esc(loan.duration)} months</div></div>
        <div><div class="metric-label">Monthly repayment</div><div class="metric-value">${money(loan.monthlyRepayment)}</div></div>
        <div><div class="metric-label">Total payable</div><div class="metric-value">${money(loan.totalPayable)}</div></div>
        <div><div class="metric-label">Outstanding</div><div class="metric-value">${money(balance)}</div></div>
      </div>
 
      <div class="card-meta">
        Telephone: ${esc(loan.phone||"—")}<br>
        Guarantor: ${esc(loan.guarantorName||"—")}<br>
        Paid: ${money(paid)}
      </div>
 
      <div class="card-actions">
        <button class="btn secondary small" data-view-sensitive="${loan.id}">View protected details</button>
        <button class="btn secondary small" data-edit-loan="${loan.id}">Edit</button>
        <button class="btn danger small" data-delete-loan="${loan.id}">Delete</button>
      </div>
    </article>`;
  }
 
  function renderLoans() {
    return pageHeader(
      "Loans",
      "Manage borrower records, loan terms and balances.",
      '<button class="btn success" id="newLoanBtn">＋ New Loan</button>'
    ) +
    `<div class="list-toolbar">
      <input id="loanSearch" class="search" type="search" placeholder="Search borrower, loan ID or phone…">
      <span class="muted">${loans.length} loans</span>
    </div>
    <div id="loanList" class="loan-grid">
      ${loans.length ? loans.map(loanCard).join("") :
        '<div class="empty"><strong>No loans yet</strong>Create your first loan to get started.</div>'}
    </div>`;
  }
 
  function paymentCard(payment) {
    const loan = loans.find(l=>l.id===payment.loanId);
 
    return `<article class="payment-card">
      <div class="card-top">
        <div>
          <div class="loan-id">PAYMENT · ${dateText(payment.date)}</div>
          <h4>${esc(loan?.fullName||payment.borrowerName||"Loan record unavailable")}</h4>
        </div>
        <span class="badge status-paid">${esc(payment.method||"Payment")}</span>
      </div>
      <div class="payment-amount">${money(payment.amount)}</div>
      <div class="card-meta">
        Loan #${esc(payment.loanNumber||loan?.loanNumber||"—")}<br>
        ${esc(payment.monthCovered||"No month specified")}<br>
        Received by: ${esc(payment.receivedBy||"—")}<br>
        ${esc(payment.notes||"")}
      </div>
      <div class="card-actions">
        <button class="btn danger small" data-delete-payment="${payment.id}">Delete payment</button>
      </div>
    </article>`;
  }
 
  function renderPayments() {
    return pageHeader(
      "Payments",
      "Record and review repayments.",
      '<button class="btn success" id="newPaymentBtn">＋ Record Payment</button>'
    ) +
    `<div class="payment-grid">
      ${payments.length ? payments.map(paymentCard).join("") :
        '<div class="empty"><strong>No payments recorded</strong>Recorded payments will appear here.</div>'}
    </div>`;
  }
 
  function renderCalculator() {
    return pageHeader("Calculator","A simple calculator for everyday arithmetic.") +
      `<section class="panel standard-calculator-panel">
        <div class="standard-calculator" role="group" aria-label="Calculator">
          <div class="calculator-topline"><span>G&amp;Y CALCULATOR</span><span id="calcStatus">Ready</span></div>
          <div class="calculator-display" aria-live="polite" aria-atomic="true">
            <div id="calcExpression" class="calculator-expression">&nbsp;</div>
            <output id="calcDisplay" class="calculator-screen" aria-label="Display">0</output>
          </div>
          <div class="calculator-keys">
            <button type="button" class="calc-key calc-function" data-calc="clear">AC</button>
            <button type="button" class="calc-key calc-function" data-calc="sign">±</button>
            <button type="button" class="calc-key calc-function" data-calc="percent">%</button>
            <button type="button" class="calc-key calc-operator" data-calc="operator" data-value="÷">÷</button>
            <button type="button" class="calc-key" data-calc="digit" data-value="7">7</button>
            <button type="button" class="calc-key" data-calc="digit" data-value="8">8</button>
            <button type="button" class="calc-key" data-calc="digit" data-value="9">9</button>
            <button type="button" class="calc-key calc-operator" data-calc="operator" data-value="×">×</button>
            <button type="button" class="calc-key" data-calc="digit" data-value="4">4</button>
            <button type="button" class="calc-key" data-calc="digit" data-value="5">5</button>
            <button type="button" class="calc-key" data-calc="digit" data-value="6">6</button>
            <button type="button" class="calc-key calc-operator" data-calc="operator" data-value="−">−</button>
            <button type="button" class="calc-key" data-calc="digit" data-value="1">1</button>
            <button type="button" class="calc-key" data-calc="digit" data-value="2">2</button>
            <button type="button" class="calc-key" data-calc="digit" data-value="3">3</button>
            <button type="button" class="calc-key calc-operator" data-calc="operator" data-value="+">+</button>
            <button type="button" class="calc-key calc-zero" data-calc="digit" data-value="0">0</button>
            <button type="button" class="calc-key" data-calc="decimal">.</button>
            <button type="button" class="calc-key calc-equals" data-calc="equals">=</button>
          </div>
          <div class="calculator-footer"><span>Keyboard supported</span><button type="button" class="calc-backspace" data-calc="backspace">⌫ Delete</button></div>
        </div>
      </section>`;
  }

  function bindStandardCalculator() {
    const display = $("calcDisplay");
    const expression = $("calcExpression");
    const status = $("calcStatus");
    if (!display) return;

    let current = "0";
    let stored = null;
    let pending = null;
    let replaceNext = false;
    let lastOperator = null;
    let lastOperand = null;

    const format = value => {
      if (!Number.isFinite(value)) return "Error";
      const rounded = Number.parseFloat(value.toPrecision(12));
      return rounded.toLocaleString("en-NG", {maximumFractionDigits:10});
    };
    const numeric = () => Number(current.replace(/,/g,""));
    const show = () => {
      display.textContent = format(numeric());
      expression.textContent = pending && stored !== null ? `${format(stored)} ${pending}` : "\u00a0";
      status.textContent = pending ? "Operation pending" : "Ready";
    };
    const calculate = (a, op, b) => {
      if (op === "+") return a + b;
      if (op === "−") return a - b;
      if (op === "×") return a * b;
      if (op === "÷") return b === 0 ? NaN : a / b;
      return b;
    };
    const clear = () => {
      current = "0"; stored = null; pending = null; replaceNext = false;
      lastOperator = null; lastOperand = null; show();
    };
    const inputDigit = digit => {
      if (current === "Error" || replaceNext) { current = digit; replaceNext = false; }
      else if (current.replace(/,/g,"").replace("-","").length < 14) current = current === "0" ? digit : current + digit;
      show();
    };
    const chooseOperator = op => {
      const value = numeric();
      if (!Number.isFinite(value)) { clear(); return; }
      if (pending && !replaceNext) {
        const result = calculate(stored, pending, value);
        if (!Number.isFinite(result)) { current = "Error"; stored = null; pending = null; show(); return; }
        current = String(Number.parseFloat(result.toPrecision(12)));
        stored = Number(current);
      } else stored = value;
      pending = op; replaceNext = true; lastOperator = null; lastOperand = null; show();
    };
    const equals = () => {
      if (pending) {
        const operand = replaceNext ? stored : numeric();
        const result = calculate(stored, pending, operand);
        expression.textContent = `${format(stored)} ${pending} ${format(operand)} =`;
        current = Number.isFinite(result) ? String(Number.parseFloat(result.toPrecision(12))) : "Error";
        lastOperator = pending; lastOperand = operand; stored = null; pending = null; replaceNext = true;
      } else if (lastOperator && lastOperand !== null) {
        const result = calculate(numeric(), lastOperator, lastOperand);
        expression.textContent = `${format(numeric())} ${lastOperator} ${format(lastOperand)} =`;
        current = Number.isFinite(result) ? String(Number.parseFloat(result.toPrecision(12))) : "Error";
        replaceNext = true;
      }
      show();
    };
    const act = (action, value) => {
      if (action === "digit") inputDigit(value);
      else if (action === "decimal") {
        if (current === "Error" || replaceNext) { current = "0."; replaceNext = false; }
        else if (!current.includes(".")) current += ".";
        show();
      } else if (action === "clear") clear();
      else if (action === "backspace") {
        if (replaceNext || current === "Error") current = "0";
        else current = current.length > 1 ? current.slice(0,-1) : "0";
        show();
      } else if (action === "sign") {
        if (current !== "0" && current !== "Error") current = current.startsWith("-") ? current.slice(1) : "-" + current;
        show();
      } else if (action === "percent") {
        if (current !== "Error") current = String(numeric()/100);
        show();
      } else if (action === "operator") chooseOperator(value);
      else if (action === "equals") equals();
    };

    document.querySelectorAll("[data-calc]").forEach(button => {
      button.addEventListener("click", () => act(button.dataset.calc, button.dataset.value));
    });
    const onKey = event => {
      if (currentPage !== "calculator") { document.removeEventListener("keydown", onKey); return; }
      if (/^[0-9]$/.test(event.key)) { event.preventDefault(); act("digit",event.key); }
      else if (event.key === ".") { event.preventDefault(); act("decimal"); }
      else if (event.key === "Enter" || event.key === "=") { event.preventDefault(); act("equals"); }
      else if (event.key === "Backspace") { event.preventDefault(); act("backspace"); }
      else if (event.key === "Escape") { event.preventDefault(); act("clear"); }
      else if (event.key === "+") { event.preventDefault(); act("operator","+"); }
      else if (event.key === "-") { event.preventDefault(); act("operator","−"); }
      else if (event.key === "*") { event.preventDefault(); act("operator","×"); }
      else if (event.key === "/") { event.preventDefault(); act("operator","÷"); }
      else if (event.key === "%") { event.preventDefault(); act("percent"); }
    };
    document.addEventListener("keydown",onKey);
    show();
  }

  function renderReports() {
    const principal = loans.reduce((sum, loan) => sum + number(loan.principal), 0);
    const payable = loans.reduce((sum, loan) => sum + number(loan.totalPayable), 0);
    const collected = payments.reduce((sum, payment) => sum + number(payment.amount), 0);
    const outstanding = loans.reduce((sum, loan) => sum + outstandingFor(loan), 0);
    const statusesCount = status => loans.filter(loan => effectiveStatus(loan) === status).length;
    return pageHeader("Reports & Analytics","A quick portfolio summary based on your existing records.") +
      `<div class="stats-grid">
        ${stat("Loans issued",loans.length)}
        ${stat("Principal disbursed",money(principal),true)}
        ${stat("Total expected",money(payable),true)}
        ${stat("Total collected",money(collected),true)}
        ${stat("Outstanding",money(outstanding),true)}
        ${stat("Collection rate",payable?(collected/payable*100).toFixed(1)+"%":"0.0%")}
      </div>
      <section class="panel report-panel">
        <h3>Loan status summary</h3>
        <div class="breakdown">
          ${statuses.map(status => `<div class="break-row"><span>${esc(status)}</span><strong>${statusesCount(status)}</strong></div>`).join("")}
        </div>
      </section>
      <section class="panel report-panel">
        <h3>Recent repayments</h3>
        <div class="breakdown">
          ${payments.slice(0,8).map(payment => `<div class="break-row"><span>${esc(payment.borrowerName || "Borrower")} · ${dateText(payment.date)}</span><strong>${money(payment.amount)}</strong></div>`).join("") || '<p class="muted">No payments recorded yet.</p>'}
        </div>
      </section>`;
  }

  function renderAbout() {
    return pageHeader("About","Application information.") +
      `<section class="panel about-card">
        <div class="about-logo">G&amp;Y</div>
        <h3>G &amp; Y Services</h3>
        <h2>G &amp; Y Services Loan Tracker</h2>
        <p>A loan administration tool for managing borrower details, calculating repayments, recording collections and monitoring outstanding balances.</p>
        <p><strong>Version:</strong> 1.0.0</p>
         <p><strong>Built by:</strong> Agah David</p>
        <p><strong>Privacy:</strong> This application is protected by Firebase Authentication. Your records are stored in your Firebase project and separated by account.</p>
        <p><strong>Support:</strong> Contact your G &amp; Y Services system administrator for assistance.</p>
      </section>`;
  }
 
  function render() {
    if (!currentUser) return;
 
    const content = currentPage==="dashboard" ? renderDashboard()
      : currentPage==="loans" ? renderLoans()
      : currentPage==="payments" ? renderPayments()
      : currentPage==="calculator" ? renderCalculator()
      : currentPage==="reports" ? renderReports()
      : renderAbout();
 
    $("mainContent").innerHTML = content;
 
    if (currentPage==="dashboard") {
      $("dashboardNewLoanBtn").addEventListener("click",()=>openLoanModal());
    }
 
    if (currentPage==="loans") {
      $("newLoanBtn").addEventListener("click",()=>openLoanModal());
      $("emptyNewLoanBtn")?.addEventListener("click",()=>openLoanModal());
 
      $("loanSearch").addEventListener("input",event=>{
        const term=event.target.value.toLowerCase();
        const matches=loans.filter(l=>
          [l.fullName,l.loanNumber,l.phone].some(v=>
            String(v||"").toLowerCase().includes(term)
          )
        );
 
        $("loanList").innerHTML=matches.length
          ? matches.map(loanCard).join("")
          : '<div class="empty"><strong>No matching loans</strong>Try another search.</div>';
 
        bindLoanActions();
      });
 
      bindLoanActions();
    }
 
    if (currentPage==="payments") {
      $("newPaymentBtn").addEventListener("click",openPaymentModal);
      bindPaymentActions();
    }

    if (currentPage==="calculator") bindStandardCalculator();
  }
 
  function bindLoanActions() {
    document.querySelectorAll("[data-view-sensitive]").forEach(button=>{
      button.addEventListener("click",()=>viewSensitiveDetails(button.dataset.viewSensitive));
    });
 
    document.querySelectorAll("[data-edit-loan]").forEach(button=>{
      button.addEventListener("click",()=>{
        openLoanModal(loans.find(l=>l.id===button.dataset.editLoan));
      });
    });
 
    document.querySelectorAll("[data-delete-loan]").forEach(button=>{
      button.addEventListener("click",()=>deleteLoan(button.dataset.deleteLoan));
    });
  }
 
  function bindPaymentActions() {
    document.querySelectorAll("[data-delete-payment]").forEach(button=>{
      button.addEventListener("click",()=>deletePayment(button.dataset.deletePayment));
    });
  }
 
  const loanFields = [
    ["fullName","Full Name",true],
    ["phone","Telephone",true,"tel"],
    ["address","Address"],
    ["classification","Classification","select",["Civil Servant","Business","Private","Other"]],
    ["employer","MDA / Employer"],
    ["idNo","ID No."],
    ["nin","NIN"],
    ["bvn","BVN"],
    ["accountName","Account Name"],
    ["accountNoBank","Account No. / Bank"],
    ["guarantorName","Guarantor Name"],
    ["guarantorPhone","Guarantor Telephone"],
    ["guarantorAddress","Guarantor Address"],
    ["guarantorOccupation","MDA / Occupation"],
    ["guarantorNin","Guarantor NIN"],
    ["loanDate","Date Loan Given",false,"date"],
    ["dueDate","Loan Due Date",false,"date"],
    ["purpose","Purpose of Loan"],
    ["notes","Additional Notes"]
  ];
 
  function inputField(field,value="") {
    const [name,label,required,type,options]=field;
    let control;
 
    if(type==="select") {
      control=`<select id="f_${name}">
        <option value="">Select…</option>
        ${options.map(o=>`<option ${value===o?"selected":""}>${o}</option>`).join("")}
      </select>`;
    } else {
      control=`<input id="f_${name}" type="${type||"text"}"
        ${required?"required":""} value="${esc(value)}">`;
    }
 
    return `<div class="field">
      <label for="f_${name}">${label}${required?' <span style="color:red">*</span>':""}</label>
      ${control}
    </div>`;
  }
 
  function closeModal() {
    $("modalRoot").innerHTML="";
  }
 
  function bindModalClose() {
    $("modalRoot").querySelectorAll("[data-close-modal]").forEach(button=>{
      button.addEventListener("click",closeModal);
    });
 
    $("modalBackdrop")?.addEventListener("click",event=>{
      if(event.target.id==="modalBackdrop") closeModal();
    });
  }
 
  async function openLoanModal(loan=null) {
    const editing=!!loan;
    let protectedValues = {};
    if (editing && !(await confirmAdminPassword())) return;
    if (editing) {
      try {
        const protectedSnap = await getDoc(sensitiveDoc(loan.id));
        if (protectedSnap.exists()) protectedValues = protectedSnap.data();
      } catch (error) {
        showToast("Could not load protected details: " + friendlyError(error), "error");
      }
      // Support older records that pre-date the separate protected collection.
      sensitiveFields.forEach(key => {
        if (!protectedValues[key] && loan[key]) protectedValues[key] = loan[key];
      });
    }
 
    const borrowerFields=loanFields.slice(0,10)
      .map(f=>inputField(f, sensitiveFields.includes(f[0]) ? (protectedValues[f[0]] || "") : (loan?.[f[0]]||""))).join("");
 
    const guarantorFields=loanFields.slice(10,15)
      .map(f=>inputField(f, sensitiveFields.includes(f[0]) ? (protectedValues[f[0]] || "") : (loan?.[f[0]]||""))).join("");
    const recordFields=loanFields.slice(15)
      .map(f=>inputField(f,loan?.[f[0]]||"")).join("");
 
    $("modalRoot").innerHTML=`
      <div class="modal-backdrop" id="modalBackdrop">
        <section class="modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h3>${editing?"Edit Loan":"Create New Loan"}</h3>
            <button class="close" type="button" data-close-modal>×</button>
          </div>
 
          <form id="loanForm">
            <div class="modal-body">
              <div class="sensitive-note">Privacy protection: NIN, BVN, account details and guarantor NIN are saved in a separate protected Firestore collection. They are not shown on loan cards and require your admin password to reveal.</div>
              <div class="form-section">
                <h4>Borrower details</h4>
                <div class="form-grid">${borrowerFields}</div>
              </div>
 
              <div class="form-section">
                <h4>Guarantor details</h4>
                <div class="form-grid">${guarantorFields}</div>
              </div>
 
              <div class="form-section">
                <h4>Loan record details</h4>
                <div class="form-grid">${recordFields}</div>
              </div>
 
              <div class="form-section">
                <h4>Loan computation</h4>
                <div class="form-grid">
                  <div class="field">
                    <label>Principal (₦) *</label>
                    <input id="f_principal" type="number" min=".01" step=".01" required value="${editing?number(loan.principal):""}">
                  </div>
                  <div class="field">
                    <label>Interest Rate (%) *</label>
                    <input id="f_rate" type="number" min="0" step=".01" required value="${editing?number(loan.rate):20}">
                  </div>
                  <div class="field">
                    <label>Duration (Months) *</label>
                    <input id="f_duration" type="number" min="1" step="1" required value="${editing?number(loan.duration):5}">
                  </div>
                  <div class="field">
                    <label>Status</label>
                    <select id="f_status">
                      ${statuses.map(s=>`<option ${((loan?.status||"Active")===s)?"selected":""}>${s}</option>`).join("")}
                    </select>
                  </div>
                </div>
 
                <p><strong>Live calculation preview</strong></p>
                <div class="preview-grid">
                  <div class="preview-item"><span>Total Interest</span><strong id="previewInterest"></strong></div>
                  <div class="preview-item"><span>Total Payable</span><strong id="previewPayable"></strong></div>
                  <div class="preview-item"><span>Monthly Repayment</span><strong id="previewMonthly"></strong></div>
                </div>
              </div>
            </div>
 
            <div class="modal-foot">
              <button class="btn secondary" type="button" data-close-modal>Cancel</button>
              <button id="saveLoanBtn" class="btn primary" type="submit">${editing?"Save Changes":"Save Loan"}</button>
            </div>
          </form>
        </section>
      </div>`;
 
    const updatePreview=()=>{
      const c=calcLoan(
        number($("f_principal").value),
        number($("f_rate").value),
        number($("f_duration").value)
      );
 
      $("previewInterest").textContent=money(c.interest);
      $("previewPayable").textContent=money(c.payable);
      $("previewMonthly").textContent=money(c.monthly);
    };
 
    ["f_principal","f_rate","f_duration"].forEach(id=>{
      $(id).addEventListener("input",updatePreview);
    });
 
    updatePreview();
    bindModalClose();
 
    $("loanForm").addEventListener("submit",async event=>{
      event.preventDefault();
 
      const button=$("saveLoanBtn");
      setBusy(button,true,"Saving loan…");
 
      try {
        const principal=number($("f_principal").value);
        const rate=number($("f_rate").value);
        const duration=number($("f_duration").value);
 
        if(principal<=0 || rate<0 || duration<1 || !Number.isInteger(duration)) {
          throw new Error("Enter a valid principal, interest rate and whole-number duration.");
        }
 
        const c=calcLoan(principal,rate,duration);
        const data={};
        const protectedData={};
 
        loanFields.forEach(f=>{
          const value=$("f_"+f[0]).value.trim();
          if (sensitiveFields.includes(f[0])) protectedData[f[0]]=value;
          else data[f[0]]=value;
        });
 
        data.principal=principal;
        data.rate=rate;
        data.duration=duration;
        data.totalInterest=c.interest;
        data.totalPayable=c.payable;
        data.monthlyRepayment=c.monthly;
        data.status=$("f_status").value;
        data.updatedAt=serverTimestamp();
 
        if(editing) {
          await setDoc(sensitiveDoc(loan.id), {
            ...protectedData,
            updatedAt: serverTimestamp()
          }, {merge:true});
          sensitiveFields.forEach(key => data[key]=deleteField());
          await updateDoc(userDoc("loans",loan.id),data);
          showToast("Loan updated. Protected details saved separately.");
        } else {
          const counterRef=doc(db,"users",currentUser.uid,"meta","loanCounter");
 
          const loanNumber=await runTransaction(db,async tx=>{
            const snap=await tx.get(counterRef);
            const next=(snap.exists()?number(snap.data().value):0)+1;
 
            tx.set(counterRef,{
              value:next,
              updatedAt:serverTimestamp()
            });
 
            return String(next).padStart(3,"0");
          });
 
          const newLoanRef = await addDoc(userCollection("loans"),{
            ...data,
            loanNumber,
            createdAt:serverTimestamp()
          });
          await setDoc(sensitiveDoc(newLoanRef.id), {
            ...protectedData,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
 
          showToast("Loan created: "+loanNumber);
        }
 
        closeModal();
      } catch(error) {
        showToast(friendlyError(error),"error");
      } finally {
        setBusy(button,false);
      }
    });
  }
 
  async function deleteLoan(id) {
    const loan=loans.find(l=>l.id===id);
    if(!loan) return;
 
    if(!confirm(`Delete loan #${loan.loanNumber} for ${loan.fullName}? This also deletes its payments and protected details. This action cannot be undone.`)) return;
 
    // Require administrator password re-entry immediately before deletion.
    if (!(await confirmAdminPassword())) return;
 
    try {
      const linked=payments.filter(p=>p.loanId===id);
 
      for(const payment of linked) {
        await deleteDoc(userDoc("payments",payment.id));
      }
 
      await deleteDoc(userDoc("loans",id));
      await deleteDoc(sensitiveDoc(id));
      showToast("Loan, protected details and linked payments deleted.");
    } catch(error) {
      showToast(friendlyError(error),"error");
    }
  }
 
  function openPaymentModal() {
    if(!loans.length) {
      showToast("Create a loan before recording a payment.","error");
      return;
    }
 
    $("modalRoot").innerHTML=`
      <div class="modal-backdrop" id="modalBackdrop">
        <section class="modal narrow" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h3>Record Payment</h3>
            <button class="close" type="button" data-close-modal>×</button>
          </div>
 
          <form id="paymentForm">
            <div class="modal-body stack">
              <div class="field">
                <label>SELECT LOAN *</label>
                <select id="p_loan" required>
                  <option value="">Choose borrower…</option>
                  ${loans.map(l=>`
                    <option value="${l.id}">
                      #${esc(l.loanNumber)} · ${esc(l.fullName)} · ${money(outstandingFor(l))} due
                    </option>
                  `).join("")}
                </select>
              </div>
 
              <div class="field">
                <label>DATE *</label>
                <input id="p_date" type="date" required value="${new Date().toISOString().slice(0,10)}">
              </div>
 
              <div class="field">
                <label>AMOUNT PAID (₦) *</label>
                <input id="p_amount" type="number" min=".01" step=".01" required>
              </div>
 
              <div class="field">
                <label>PAYMENT METHOD</label>
                <select id="p_method">
                  <option>Bank Transfer</option>
                  <option>Cash</option>
                  <option>POS</option>
                  <option>USSD</option>
                  <option>Other</option>
                </select>
              </div>
 
              <div class="field"><label>MONTH COVERED</label><input id="p_month" placeholder="e.g. November 2026"></div>
              <div class="field"><label>RECEIVED BY</label><input id="p_received"></div>
              <div class="field"><label>NOTES</label><textarea id="p_notes"></textarea></div>
            </div>
 
            <div class="modal-foot">
              <button class="btn secondary" type="button" data-close-modal>Cancel</button>
              <button id="savePaymentBtn" class="btn primary" type="submit">Save Payment</button>
            </div>
          </form>
        </section>
      </div>`;
 
    bindModalClose();
 
    $("paymentForm").addEventListener("submit",async event=>{
      event.preventDefault();
 
      const button=$("savePaymentBtn");
      setBusy(button,true,"Saving payment…");
 
      try {
        const loan=loans.find(l=>l.id===$("p_loan").value);
        const amount=number($("p_amount").value);
 
        if(!loan || amount<=0) throw new Error("Select a loan and enter a valid payment amount.");
 
        await addDoc(userCollection("payments"),{
          loanId:loan.id,
          loanNumber:loan.loanNumber,
          borrowerName:loan.fullName,
          date:$("p_date").value,
          amount,
          method:$("p_method").value,
          monthCovered:$("p_month").value.trim(),
          receivedBy:$("p_received").value.trim(),
          notes:$("p_notes").value.trim(),
          createdAt:serverTimestamp()
        });
 
        if(paidFor(loan.id)+amount>=number(loan.totalPayable)) {
          await updateDoc(userDoc("loans",loan.id),{
            status:"Fully Paid",
            statusBeforePaid:loan.status==="Fully Paid"?(loan.statusBeforePaid||"Active"):loan.status,
            updatedAt:serverTimestamp()
          });
        }
 
        showToast("Payment recorded successfully.");
        closeModal();
      } catch(error) {
        showToast(friendlyError(error),"error");
      } finally {
        setBusy(button,false);
      }
    });
  }
 
  async function deletePayment(id) {
    const payment=payments.find(p=>p.id===id);
    if(!payment) return;
 
    if(!confirm(`Delete this ${money(payment.amount)} payment?`)) return;
 
    try {
      await deleteDoc(userDoc("payments",id));
 
      const loan=loans.find(l=>l.id===payment.loanId);
 
      if(loan && loan.status==="Fully Paid" &&
        paidFor(loan.id)-number(payment.amount)<number(loan.totalPayable)) {
        await updateDoc(userDoc("loans",loan.id),{
          status:loan.statusBeforePaid||"Active",
          statusBeforePaid:null,
          updatedAt:serverTimestamp()
        });
      }
 
      showToast("Payment deleted.");
    } catch(error) {
      showToast(friendlyError(error),"error");
    }
  }
