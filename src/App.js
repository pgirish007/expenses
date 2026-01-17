import React, { useState, useEffect, useRef } from "react";
import { useGoogleLogin, googleLogout } from '@react-oauth/google';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { ExpenseList, ExpenseForm, LoadingBar } from "./components/index";
import { MDCSnackbar } from "@material/snackbar/dist/mdc.snackbar.js";

import "@material/fab/dist/mdc.fab.css";
import "@material/button/dist/mdc.button.css";
import "@material/toolbar/dist/mdc.toolbar.css";
import "@material/snackbar/dist/mdc.snackbar.css";
import "@material/card/dist/mdc.card.css";

import "./App.css";

// --- COLORS FOR THE CHART ---
const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#AF19FF', '#FF1919', '#0019FF'];

const SPREADSHEET_ID = process.env.REACT_APP_SHEET_ID;

// Helper: Formats JS Date to "MM/DD/YYYY" for the UI to display
const formatDateForUI = (dateObj) => {
  const year = dateObj.getFullYear();
  const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
  const day = dateObj.getDate().toString().padStart(2, '0');
  return `${month}/${day}/${year}`;
};

const App = () => {
  // --- STATE MANAGEMENT ---
  const [signedIn, setSignedIn] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  
  // Data State
  const [accounts, setAccounts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [currentMonth, setCurrentMonth] = useState(undefined);
  const [previousMonth, setPreviousMonth] = useState(undefined);

  // Dashboard State
  const [categoryStats, setCategoryStats] = useState([]);
  const [filterCategory, setFilterCategory] = useState(null); 
  const [showChart, setShowChart] = useState(true);
  const [iconMap, setIconMap] = useState({});
  
  // Form State
  const [expense, setExpense] = useState({});

  // Refs
  const snackbarRef = useRef(null);
  const snackbarInstance = useRef(null);

  // --- GOOGLE AUTH ---
  const login = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      await loadGapiClient();
      window.gapi.client.setToken({ access_token: tokenResponse.access_token });
      setSignedIn(true);
      loadData();
    },
    onError: error => console.log('Login Failed:', error),
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly',
  });

  const logout = () => {
    googleLogout();
    setSignedIn(false);
    setExpenses([]);
  };

  const loadGapiClient = () => {
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "https://apis.google.com/js/api.js";
      script.onload = () => {
        window.gapi.load("client", () => {
          window.gapi.client.init({
            discoveryDocs: ["https://sheets.googleapis.com/$discovery/rest?version=v4"],
          }).then(resolve);
        });
      };
      document.body.appendChild(script);
    });
  };

  useEffect(() => {
    if (snackbarRef.current) snackbarInstance.current = new MDCSnackbar(snackbarRef.current);
    const handleKeyUp = (e) => {
      if (signedIn) {
        if (!showExpenseForm && e.keyCode === 65) onExpenseNew();
        else if (showExpenseForm && e.keyCode === 27) handleExpenseCancel();
      }
    };
    document.addEventListener("keyup", handleKeyUp);
    return () => document.removeEventListener("keyup", handleKeyUp);
  }, [signedIn, showExpenseForm]);

  // --- READ LOGIC (FROM SHEET TO APP) ---
  const parseExpense = (value, index) => {
    // Robust Amount Cleaning
    let rawAmount = value[4] || "0";
    if (typeof rawAmount === 'string') {
        rawAmount = rawAmount.replace(/[^0-9.-]+/g, "");
    }

    // Google API returns the *result* of the =DATE formula (e.g., "01/03/2026")
    // because we ask for 'FORMATTED_VALUE' in loadData.
    // We just pass this string to the UI.
    return {
      id: `Expenses!A${index + 2}`,
      date: value[0] || "", 
      description: value[1],
      category: value[3] ? value[3].trim() : "Uncategorized",
      amount: rawAmount,
      account: value[2]
    };
  };

  // --- WRITE LOGIC (FROM APP TO SHEET) ---
  const formatExpense = (exp) => {
    // The UI gives us "MM/DD/YYYY" (e.g. "01/03/2026")
    const parts = exp.date.split('-'); 
    // parts[0] = Month, parts[1] = Day, parts[2] = Year

    // CRITICAL: We convert this string into the Google Sheets FORMULA
    // Input: "01/03/2026" -> Output: "=DATE(2026, 1, 3)"
    // This ensures the sheet stores it strictly as a date function.
    const dateFormula = `=DATE(${parts[0]}, ${parts[1]}, ${parts[2]})`;

    return [
      dateFormula,      // Column A: The Formula
      exp.description,  // Column B
      exp.account,      // Column C
      exp.category,     // Column D
      exp.amount        // Column E
    ];
  };

  // --- CHART STATS LOGIC ---
  const calculateStats = (allExpenses) => {
    const now = new Date();
    const currentMonth = now.getMonth(); 
    const currentYear = now.getFullYear();
    
    const statsMap = {};

    allExpenses.forEach(exp => {
      // Robust Date Parsing for Charting
      // We expect "MM/DD/YYYY" or "YYYY-MM-DD"
      const parts = exp.date.split(/[-/]/); 
      let expDate;
      
      if (parts.length === 3) {
          if (parts[0].length === 4) {
             // YYYY-MM-DD
             expDate = new Date(parts[0], parts[1] - 1, parts[2]);
          } else if (parts[2].length === 4) {
             // MM/DD/YYYY
             expDate = new Date(parts[2], parts[1] - 1, parts[0]);
          }
      }
      if (expDate && expDate.getMonth() === currentMonth && expDate.getFullYear() === currentYear) {
        const amount = parseFloat(exp.amount) || 0;
        if (statsMap[exp.category]) {
          statsMap[exp.category] += amount;
        } else {
          statsMap[exp.category] = amount;
        }
      }
    });

    const data = Object.keys(statsMap).map(cat => ({
      name: cat,
      value: statsMap[cat]
    }));
    
    return data.sort((a, b) => b.value - a.value);
  };

  const loadData = () => {
    setProcessing(true);
    window.gapi.client.sheets.spreadsheets.values.batchGet({
      spreadsheetId: SPREADSHEET_ID,
      // CRITICAL: We ask for FORMATTED_VALUE. 
      // This means if the cell has "=DATE(2026,1,3)", API gives us "01/03/2026".
      // This makes it easy for Javascript to display it, while the sheet keeps the formula.
      valueRenderOption: 'FORMATTED_VALUE', 
      dateTimeRenderOption: 'FORMATTED_STRING',
      ranges: ["Data!A2:A50", "Data!E2:F50", "Expenses!A2:F", "Current!H1", "Previous!H1"]
    }).then(response => {
      const result = response.result.valueRanges;
      
      // Load Icons
      const categoryRows = result[1].values || [];
      const loadedCategories = categoryRows.map(row => row[0]);
      const loadedIconMap = categoryRows.reduce((acc, row) => {
          acc[row[0]] = row[1] || 'attach_money'; 
          return acc;
      }, {});

      const loadedExpenses = (result[2].values || []).map(parseExpense).reverse();
      
      setAccounts(result[0].values ? result[0].values.map(i => i[0]) : []);
      setCategories(loadedCategories);
      setIconMap(loadedIconMap);
      setExpenses(loadedExpenses); 
      setCategoryStats(calculateStats(loadedExpenses)); 
      
      setCurrentMonth(result[3].values ? result[3].values[0][0] : 0);
      setPreviousMonth(result[4].values ? result[4].values[0][0] : 0);
      setProcessing(false);
    });
  };

  // --- ACTIONS ---
  const handleSliceClick = (data) => {
    if (filterCategory === data.name) {
      setFilterCategory(null);
    } else {
      setFilterCategory(data.name);
    }
  };

  const onExpenseNew = () => {
    const now = new Date();
    setExpense({
      amount: "", description: "", date: formatDateForUI(now),
      category: categories[0] || "", account: accounts[0] || ""
    });
    setShowExpenseForm(true);
  };

  const handleExpenseSubmit = () => {
    setProcessing(true); setShowExpenseForm(false);
    const isUpdate = !!expense.id;
    
    // We explicitly USER_ENTERED so Google Sheets evaluates the =DATE(...) formula
    const apiCall = isUpdate 
        ? window.gapi.client.sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: expense.id, valueInputOption: "USER_ENTERED", values: [formatExpense(expense)] })
        : window.gapi.client.sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: "Expenses!A1", valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS", values: [formatExpense(expense)] });

    apiCall.then(() => {
        if(snackbarInstance.current) snackbarInstance.current.show({ message: `Expense ${isUpdate ? "updated" : "added"}!` });
        loadData();
    }).catch(err => {
        console.error("Submit Error", err);
        setProcessing(false);
    });
  };

  const handleExpenseDelete = (expToDelete) => {
    setProcessing(true); setShowExpenseForm(false);
    const expenseRow = expToDelete.id.substring(10);
    window.gapi.client.sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { requests: [{ deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: expenseRow - 1, endIndex: expenseRow } } }] }
    }).then(() => {
        if(snackbarInstance.current) snackbarInstance.current.show({ message: "Expense deleted!" });
        loadData();
    });
  };

  // --- RENDER ---
  const renderDashboard = () => (
    <div className="mdc-card" style={{ padding: '10px', marginBottom: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="mdc-card__subtitle" style={{ margin: 0 }}>This Month Breakdown</h2>
        <button className="mdc-button" onClick={() => setShowChart(!showChart)}>
           {showChart ? "Show List" : "Show Chart"}
        </button>
      </div>

      {showChart ? (
        <div style={{ width: '100%', height: 230, marginBottom: '35px'}}>
          {categoryStats.length > 0 ? (
            <ResponsiveContainer>
              <PieChart>
                <Pie
                  data={categoryStats}
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                  onClick={handleSliceClick}
                  cursor="pointer"
                >
                  {categoryStats.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} opacity={filterCategory === entry.name ? 1 : 0.7} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => `$${value.toFixed(2)}`} />
                <Legend verticalAlign="bottom" height={36}/>
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="center" style={{ paddingTop: '80px', color: '#999', fontStyle: 'italic' }}>
               No expenses for this month
            </div>
          )}
          
          <div className="center" style={{fontSize: '0.8rem', color: '#666', marginTop: '25px'}}>
            {filterCategory ? `Filtering: ${filterCategory}` : (categoryStats.length > 0 ? "Click a slice to filter" : "")}
          </div>
        </div>
      ) : (
        <ul className="mdc-list mdc-list--dense">
            {categoryStats.length > 0 ? (
                categoryStats.map((stat, index) => (
                    <li 
                    key={index} 
                    className="mdc-list-item" 
                    onClick={() => handleSliceClick(stat)}
                    style={{ cursor: 'pointer', backgroundColor: filterCategory === stat.name ? '#f0f0f0' : 'white' }}
                    >
                    <span className="mdc-list-item__text" style={{ marginRight: '10px'}}>{stat.name} : </span>
                    <span className="mdc-list-item__meta" style={{ color: COLORS[index % COLORS.length], fontWeight: 'bold' }}>
                        ${stat.value.toFixed(2)}
                    </span>
                    </li>
                ))
            ) : (
                <li className="mdc-list-item center">No data</li>
            )}
        </ul>
      )}
    </div>
  );

  const renderBody = () => {
    if (processing) return <LoadingBar />;
    if (showExpenseForm) return <ExpenseForm categories={categories} accounts={accounts} expense={expense} onSubmit={handleExpenseSubmit} onCancel={() => setShowExpenseForm(false)} onDelete={handleExpenseDelete} onChange={(attr, val) => setExpense(prev => ({ ...prev, [attr]: val }))} />;

    const visibleExpenses = filterCategory 
      ? expenses.filter(e => e.category === filterCategory)
      : expenses;

    return (
      <div>
        <div className="mdc-card">
          <section className="mdc-card__primary">
            <h2 className="mdc-card__subtitle">Total This Month:</h2>
            <h1 className="mdc-card__title mdc-card__title--large center">{currentMonth || "..."}</h1>
          </section>
        </div>
        
        {renderDashboard()}

        {filterCategory && (
            <div className="center" style={{ margin: '10px 0' }}>
                <button className="mdc-button mdc-button--outlined" onClick={() => setFilterCategory(null)}>
                    Clear Filter ({filterCategory})
                </button>
            </div>
        )}
        
        <ExpenseList 
            expenses={visibleExpenses.slice(0, 30)} 
            onSelect={(e) => { setExpense(e); setShowExpenseForm(true); }} 
            iconMap={iconMap}
        />
        
        <button onClick={onExpenseNew} className="mdc-fab app-fab--absolute material-icons" aria-label="Add expense"><span className="mdc-fab__icon">add</span></button>
      </div>
    );
  };

  return (
    <div>
      <header className="mdc-toolbar mdc-toolbar--fixed">
        <div className="mdc-toolbar__row">
          <section className="mdc-toolbar__section mdc-toolbar__section--align-start"><span className="mdc-toolbar__title">Expenses</span></section>
          <section className="mdc-toolbar__section mdc-toolbar__section--align-end">
            {!signedIn ? <a className="material-icons mdc-toolbar__icon" onClick={() => login()}>perm_identity</a> : <a className="material-icons mdc-toolbar__icon" onClick={logout}>exit_to_app</a>}
          </section>
        </div>
      </header>
      <div className="toolbar-adjusted-content">
        {!signedIn ? <div className="center"><button className="mdc-button sign-in" onClick={() => login()}>Sign In with Google</button></div> : renderBody()}
      </div>
      <div ref={snackbarRef} className="mdc-snackbar" aria-live="assertive" aria-atomic="true" aria-hidden="true"><div className="mdc-snackbar__text" /><div className="mdc-snackbar__action-wrapper"><button type="button" className="mdc-button mdc-snackbar__action-button" aria-hidden="true" /></div></div>
    </div>
  );
};

export default App;