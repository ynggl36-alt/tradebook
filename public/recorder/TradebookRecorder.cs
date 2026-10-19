// Tradebook Recorder 0.4.1 - PASSIVE ACCOUNT RECORDER
// Replace the entire existing TradebookRecorder AddOn source with this file.
// Reads executions, account values, positions and prices. No network client or order-entry commands.
// Compile and compare the available account executions before relying on it.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using System.Xml;
using System.Xml.Linq;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Tools;

namespace NinjaTrader.NinjaScript.AddOns
{
    public class TradebookRecorder : AddOnBase
    {
        private NTMenuItem parentMenu;
        private NTMenuItem recorderMenu;
        private TradebookRecorderWindow recorderWindow;

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Name = "TradebookRecorder";
                Description = "Passive account execution and minute-bar recorder; local files only.";
            }
        }

        protected override void OnWindowCreated(Window window)
        {
            ControlCenter controlCenter = window as ControlCenter;
            if (controlCenter == null) return;
            parentMenu = controlCenter.FindFirst("ControlCenterMenuItemNew") as NTMenuItem;
            if (parentMenu == null) return;
            recorderMenu = new NTMenuItem { Header = "Tradebook recorder" };
            recorderMenu.Style = Application.Current.TryFindResource("MainMenuItem") as Style;
            recorderMenu.Click += OpenRecorder;
            parentMenu.Items.Add(recorderMenu);
            if (TradebookRecorderSettings.Load().AutoStart)
                controlCenter.Dispatcher.BeginInvoke(new Action(delegate { if (recorderWindow == null) OpenRecorder(null, null); }));
        }

        private void OpenRecorder(object sender, RoutedEventArgs e)
        {
            if (recorderWindow == null)
            {
                recorderWindow = new TradebookRecorderWindow();
                recorderWindow.Closed += delegate { recorderWindow = null; };
                recorderWindow.Show();
            }
            else recorderWindow.Activate();
        }

        protected override void OnWindowDestroyed(Window window)
        {
            if (!(window is ControlCenter)) return;
            if (recorderMenu != null)
            {
                recorderMenu.Click -= OpenRecorder;
                if (parentMenu != null) parentMenu.Items.Remove(recorderMenu);
                recorderMenu = null;
            }
            if (recorderWindow != null) recorderWindow.Close();
        }
    }

    internal sealed class TradebookRecorderSettings
    {
        internal bool AutoStart;
        internal bool SimulatorOnly;
        internal bool RecordPrices;
        internal int PriceHistoryDays;
        internal string Contracts = "MNQ 12-26; NQ 12-26";
        internal string Prefixes = "LFE; LFF";
        private static string SettingsPath { get { return Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "TradebookRecorder", "settings-v2.xml"); } }

        internal static TradebookRecorderSettings Load()
        {
            TradebookRecorderSettings value = new TradebookRecorderSettings();
            try
            {
                if (!File.Exists(SettingsPath) || new FileInfo(SettingsPath).Length > 16000) return value;
                XmlReaderSettings options = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 16000 };
                XElement root;
                using (XmlReader reader = XmlReader.Create(SettingsPath, options)) root = XDocument.Load(reader).Root;
                if (root == null || root.Name != "TradebookRecorderSettings") return value;
                value.Contracts = (string)root.Attribute("contracts") ?? value.Contracts;
                value.Prefixes = (string)root.Attribute("accountPrefixes") ?? value.Prefixes;
                value.AutoStart = (string)root.Attribute("autoStart") == "true";
                value.SimulatorOnly = (string)root.Attribute("mode") == "Sim101Only";
                // Older settings migrate to light mode; price history is explicit opt-in.
                value.RecordPrices = (string)root.Attribute("recordPrices") == "true";
                int history;
                value.PriceHistoryDays = Int32.TryParse((string)root.Attribute("priceHistoryDays"), out history) ? Math.Max(0, Math.Min(7, history)) : 0;
            }
            catch { value.AutoStart = false; }
            return value;
        }

        internal void Save()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath));
            string temporary = SettingsPath + ".writing";
            new XDocument(new XElement("TradebookRecorderSettings", new XAttribute("contracts", Contracts),
                new XAttribute("accountPrefixes", Prefixes),
                new XAttribute("autoStart", AutoStart ? "true" : "false"),
                new XAttribute("mode", SimulatorOnly ? "Sim101Only" : "AccountsReadOnly"),
                new XAttribute("recordPrices", RecordPrices ? "true" : "false"),
                new XAttribute("priceHistoryDays", PriceHistoryDays))).Save(temporary);
            if (File.Exists(SettingsPath)) File.Replace(temporary, SettingsPath, SettingsPath + ".previous");
            else File.Move(temporary, SettingsPath);
        }
    }

    internal sealed class TradebookRecorderWindow : NTWindow
    {
        private readonly TextBox contracts = new TextBox { Text = "MNQ 12-26; NQ 12-26" };
        private readonly TextBox prefixes = new TextBox { Text = "LFE; LFF" };
        private readonly TextBlock status = new TextBlock { TextWrapping = TextWrapping.Wrap };
        private readonly Button start = new Button { Content = "Start recording", Padding = new Thickness(12, 6, 12, 6) };
        private readonly ComboBox mode = new ComboBox { Margin = new Thickness(0, 0, 0, 10) };
        private readonly CheckBox autoStart = new CheckBox { Content = "Start this recorder automatically with NinjaTrader", Margin = new Thickness(0, 0, 0, 10) };
        private readonly Button stop = new Button { Content = "Stop and save", IsEnabled = false, Padding = new Thickness(12, 6, 12, 6) };
        private readonly CheckBox recordPrices = new CheckBox { Content = "Also collect one-minute prices (optional; adds platform work)", Margin = new Thickness(0, 6, 0, 6) };
        private readonly TextBox historyDays = new TextBox { Text = "0", Width = 45, HorizontalAlignment = HorizontalAlignment.Left };
        private readonly DispatcherTimer refresh = new DispatcherTimer();
        private TradebookCapture capture;
        private bool stopping;
        private bool allowClose;
        private bool closeAfterStop;

        public TradebookRecorderWindow()
        {
            TradebookRecorderSettings settings = TradebookRecorderSettings.Load();
            contracts.Text = settings.Contracts;
            prefixes.Text = settings.Prefixes;
            mode.Items.Add("Connected accounts - read-only (excludes local simulators)");
            mode.Items.Add("Sim101 test only");
            mode.SelectedIndex = settings.SimulatorOnly ? 1 : 0;
            autoStart.IsChecked = settings.AutoStart;
            recordPrices.IsChecked = settings.RecordPrices;
            historyDays.Text = settings.PriceHistoryDays.ToString(CultureInfo.InvariantCulture);
            historyDays.IsEnabled = settings.RecordPrices;
            recordPrices.Click += delegate { historyDays.IsEnabled = recordPrices.IsChecked == true && capture == null; };
            Caption = "Tradebook recorder - read-only";
            Width = 640;
            Height = 690;
            MinWidth = 520;
            MinHeight = 450;
            StackPanel panel = new StackPanel { Margin = new Thickness(20), Background = SystemColors.WindowBrush };
            panel.Children.Add(Label("PASSIVE RECORDER - version 0.4.1", 20));
            panel.Children.Add(Label("Light mode records fills and connected-account snapshots. Minute-price collection is optional. Chrome reads the saved folder and syncs your private journal.", 14));
            panel.Children.Add(mode);
            panel.Children.Add(autoStart);
            panel.Children.Add(Label("Account name prefixes, separated by semicolons (LFE / LFF covers your Lucid evaluations and funded accounts):", 13));
            panel.Children.Add(prefixes);
            panel.Children.Add(Label("Optional candle contracts, separated by semicolons (maximum two):", 13));
            panel.Children.Add(contracts);
            panel.Children.Add(Label("Execution capture automatically includes NQ, MNQ, ES and MES across expiries. The contract boxes above select optional candle data only. Connected accounts are discovered automatically. Keep this window open. Sim101 test mode requires Sim101 to be flat at startup.", 13));
            panel.Children.Add(recordPrices);
            panel.Children.Add(Label("Optional price history: days back (0 = today only; maximum 7). Leave prices off during normal trading for the lowest load.", 12));
            panel.Children.Add(historyDays);
            WrapPanel buttons = new WrapPanel { Margin = new Thickness(0, 12, 0, 12) };
            buttons.Children.Add(start);
            stop.Margin = new Thickness(8, 0, 0, 0);
            buttons.Children.Add(stop);
            panel.Children.Add(buttons);
            Button copy = new Button { Content = "Copy saved-folder path", Padding = new Thickness(8), HorizontalAlignment = HorizontalAlignment.Left };
            copy.Click += delegate { Clipboard.SetText(capture != null ? capture.OutputFolder : TradebookCapture.FolderFor(mode.SelectedIndex == 1)); };
            panel.Children.Add(copy);
            panel.Children.Add(Label("Fills are saved about every 10 seconds; balances and positions about every 60 seconds. Companion CSV exports refresh when you stop and save. Existing files stay in the same folder.", 13));
            status.Margin = new Thickness(0, 12, 0, 0);
            status.Foreground = SystemColors.WindowTextBrush;
            status.Text = "Stopped. No accounts are being recorded.";
            panel.Children.Add(status);
            Content = new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Background = SystemColors.WindowBrush };
            start.Click += StartCapture;
            autoStart.Click += delegate { try { SaveSettings(); } catch (Exception error) { status.Text = "Settings could not be saved: " + error.Message; } };
            stop.Click += delegate { BeginStop(false); };
            refresh.Interval = TimeSpan.FromSeconds(2);
            refresh.Tick += delegate { if (capture != null) status.Text = capture.Status; };
            refresh.Start();
            Closing += delegate(object sender, System.ComponentModel.CancelEventArgs e)
            {
                if (allowClose) return;
                if (capture == null) { refresh.Stop(); return; }
                e.Cancel = true;
                BeginStop(true);
            };
            if (settings.AutoStart) Dispatcher.BeginInvoke(new Action(delegate { StartCapture(null, null); }));
        }

        private void SaveSettings()
        {
            new TradebookRecorderSettings { Contracts = contracts.Text, Prefixes = prefixes.Text, SimulatorOnly = mode.SelectedIndex == 1, AutoStart = autoStart.IsChecked == true,
                RecordPrices = recordPrices.IsChecked == true, PriceHistoryDays = ReadHistoryDays() }.Save();
        }

        private int ReadHistoryDays()
        {
            int value;
            if (!Int32.TryParse(historyDays.Text, out value) || value < 0 || value > 7)
                throw new ArgumentException("Price history must be a whole number from 0 to 7 days.");
            return value;
        }

        private static TextBlock Label(string text, double size)
        {
            return new TextBlock { Text = text, FontSize = size, TextWrapping = TextWrapping.Wrap,
                Foreground = SystemColors.WindowTextBrush, Margin = new Thickness(0, 0, 0, 10) };
        }

        private void StartCapture(object sender, RoutedEventArgs e)
        {
            try
            {
                if (capture != null || stopping) return;
                SaveSettings();
                capture = new TradebookCapture(contracts.Text, prefixes.Text, mode.SelectedIndex == 1, recordPrices.IsChecked == true, ReadHistoryDays());
                capture.Start();
                start.IsEnabled = false;
                stop.IsEnabled = true;
                contracts.IsEnabled = false;
                mode.IsEnabled = false;
                prefixes.IsEnabled = false;
                recordPrices.IsEnabled = false;
                historyDays.IsEnabled = false;
            }
            catch (Exception error)
            {
                status.Text = "Could not start: " + error.Message;
                if (capture != null)
                {
                    TradebookCapture failed = capture;
                    capture = null;
                    Task.Run(delegate { failed.StopAndSave(); }).ContinueWith(delegate(Task completed) { if (completed.IsFaulted) { Exception observed = completed.Exception; } }, TaskScheduler.Default);
                }
            }
        }

        private void BeginStop(bool closeWhenSaved)
        {
            if (closeWhenSaved) closeAfterStop = true;
            if (capture == null || stopping) return;
            stopping = true;
            stop.IsEnabled = false;
            start.IsEnabled = false;
            TradebookCapture closing = capture;
            status.Text = "Stopping subscriptions and saving files...";
            Task saving = Task.Factory.StartNew(delegate { closing.StopAndSave(); },
                CancellationToken.None, TaskCreationOptions.None, TaskScheduler.Default);
            saving.ContinueWith(delegate(Task completed)
            {
                // Keep disk work off the UI thread and use a regular callback for
                // compatibility with the NinjaScript editor's syntax parser.
                Exception error = completed.IsFaulted ? completed.Exception.GetBaseException() : null;
                if (Dispatcher.HasShutdownStarted || Dispatcher.HasShutdownFinished) return;
                Dispatcher.BeginInvoke(new Action(delegate
                {
                    status.Text = error == null ? closing.Status : "Save error: " + error.Message;
                    capture = null;
                    stopping = false;
                    start.IsEnabled = true;
                    contracts.IsEnabled = true;
                    mode.IsEnabled = true;
                    prefixes.IsEnabled = true;
                    recordPrices.IsEnabled = true;
                    historyDays.IsEnabled = recordPrices.IsChecked == true;
                    if (closeAfterStop)
                    {
                        allowClose = true;
                        refresh.Stop();
                        Close();
                    }
                }));
            }, TaskScheduler.Default);
        }
    }

    internal sealed class TradebookCapture
    {
        internal static string FolderFor(bool simulatorOnly) { return Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "TradebookRecorder", simulatorOnly ? "simulator-v1" : "accounts-v2"); }
        internal readonly string OutputFolder;
        private readonly bool simulatorOnly;
        private readonly bool recordPrices;
        private readonly int historyDays;
        private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
        private readonly string[] instruments;
        private readonly string[] accountPrefixes;
        private readonly TimeZoneInfo sourceZone;
        private readonly TimeZoneInfo dayZone = TimeZoneInfo.FindSystemTimeZoneById("Central Standard Time");
        private readonly BlockingCollection<Action> work = new BlockingCollection<Action>(4096);
        private readonly ConcurrentQueue<string> issueLog = new ConcurrentQueue<string>();
        private readonly Dictionary<string, CaptureDay> days = new Dictionary<string, CaptureDay>();
        private readonly List<Feed> feeds = new List<Feed>();
        private readonly object messageGate = new object();
        private readonly object executionGate = new object();
        private readonly Dictionary<string, ExecutionCopy> queuedExecutions = new Dictionary<string, ExecutionCopy>(StringComparer.Ordinal);
        private readonly Dictionary<string, RecoveryState> recovery = new Dictionary<string, RecoveryState>(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, byte> recoveryNeeded = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
        private DateTime nextStateUtc;
        private int statusRefreshQueued;
        private int inactiveCount;
        private string message = "Not started.";
        private readonly object accountGate = new object();
        private readonly Dictionary<string, Account> accounts = new Dictionary<string, Account>(StringComparer.Ordinal);
        private int accountCount;
        private readonly object valueGate = new object();
        // Support is observed per account item: unknown default zero is never a balance.
        private readonly Dictionary<string, HashSet<AccountItem>> observedItems = new Dictionary<string, HashSet<AccountItem>>(StringComparer.Ordinal);
        private static readonly AccountItem[] stateItems = new AccountItem[] { AccountItem.CashValue, AccountItem.NetLiquidation, AccountItem.RealizedProfitLoss, AccountItem.UnrealizedProfitLoss };
        private FileStream fileLock;
        private Task writer;
        private System.Threading.Timer reconcile;
        private volatile bool accepting;
        private volatile bool stopped;
        private int warnings;
        private int snapshotBusy;
        private int stopStarted;
        private readonly object snapshotGate = new object();
        private int observedFills;
        private int observedBars;

        internal string Status
        {
            get
            {
                lock (messageGate)
                    return (stopped ? "Stopped. " : simulatorOnly ? "Sim101 test. " : "Accounts read-only. ") + message + "\nConnected accounts monitored: " + accountCount + ". Inactive accounts skipped: " + inactiveCount + ". Prices: " + (recordPrices ? "on" : "off") + ". Observed this run: " + observedFills + " fill records; " + observedBars + " candles. Warnings: " + warnings + ".\n" + OutputFolder;
            }
        }

        internal TradebookCapture(string contractText, string prefixText, bool simOnly, bool collectPrices, int lookbackDays)
        {
            simulatorOnly = simOnly;
            recordPrices = collectPrices;
            historyDays = Math.Max(0, Math.Min(7, lookbackDays));
            OutputFolder = FolderFor(simOnly);
            accountPrefixes = prefixText.Split(';').Select(s => s.Trim()).Where(s => s.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            if (!simOnly && (accountPrefixes.Length < 1 || accountPrefixes.Length > 10 || accountPrefixes.Any(p => !System.Text.RegularExpressions.Regex.IsMatch(p, @"^[A-Za-z0-9_-]{1,30}$"))))
                throw new ArgumentException("Enter one to ten account name prefixes, for example LFE; LFF.");
            instruments = contractText.Split(';').Select(s => s.Trim().ToUpperInvariant()).Where(s => s.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            if (instruments.Length < 1 || instruments.Length > 2) throw new ArgumentException("Enter one or two exact futures contracts.");
            foreach (string contract in instruments)
                if (!System.Text.RegularExpressions.Regex.IsMatch(contract, @"^(MNQ|NQ|MES|ES) (0[1-9]|1[0-2])-\d{2}$", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                    throw new ArgumentException("Use an exact NQ, MNQ, ES or MES contract, such as MNQ 12-26.");
            sourceZone = NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo;
        }

        internal void Start()
        {
            if (simulatorOnly)
            {
                Account testAccount;
                lock (Account.All) testAccount = Account.All.FirstOrDefault(a => a.Name == "Sim101");
                if (testAccount == null) throw new InvalidOperationException("Sim101 was not found. Open NinjaTrader's simulator first.");
                lock (testAccount.Positions)
                    if (testAccount.Positions.Any(p => p.Quantity != 0)) throw new InvalidOperationException("Sim101 must be flat before this test starts.");
            }
            Directory.CreateDirectory(OutputFolder);
            fileLock = new FileStream(Path.Combine(OutputFolder, "recorder.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            accepting = true;
            writer = Task.Factory.StartNew(WriteLoop, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            SetMessage("Light recording; fills save about every 10 seconds; account snapshots about every 60 seconds.");
            SynchronizeAccounts();
            // Polling the current-session collection also recovers fills exposed after a reconnect.
            // It is not a way to retrieve full historical executions from NinjaTrader's database.
            reconcile = new System.Threading.Timer(delegate { SnapshotExecutions(); }, null, Timeout.Infinite, 30000);
            Account.AccountStatusUpdate += OnAccountStatus;
            reconcile.Change(0, 30000);
            if (recordPrices) foreach (string contract in instruments) RequestPrices(contract);
        }

        private bool EligibleAccount(string name)
        {
            if (simulatorOnly) return name == "Sim101";
            return !String.IsNullOrWhiteSpace(name) && !name.StartsWith("Sim", StringComparison.OrdinalIgnoreCase)
                && !name.StartsWith("Playback", StringComparison.OrdinalIgnoreCase)
                && accountPrefixes.Any(p => name.StartsWith(p, StringComparison.OrdinalIgnoreCase));
        }

        private bool Connected(Account account)
        {
            try { return simulatorOnly || (account.Connection != null && account.Connection.Status == ConnectionStatus.Connected); }
            catch { return false; }
        }

        private Account[] SynchronizeAccounts()
        {
            Account[] candidates;
            // Copy references under the platform lock; filter and subscribe outside it.
            lock (Account.All) candidates = Account.All.Where(a => EligibleAccount(a.Name)).ToArray();
            Account[] available = candidates.Where(Connected).ToArray();
            inactiveCount = candidates.Length - available.Length;
            Dictionary<string, Account> incoming = new Dictionary<string, Account>(StringComparer.Ordinal);
            foreach (Account candidate in available) incoming[candidate.Name] = candidate;
            lock (accountGate)
            {
                if (!accepting) return new Account[0];
                foreach (string key in accounts.Keys.ToArray())
                {
                    Account replacement;
                    if (!incoming.TryGetValue(key, out replacement) || !Object.ReferenceEquals(replacement, accounts[key]))
                    {
                        Account closing = accounts[key];
                        closing.ExecutionUpdate -= OnExecution;
                        closing.AccountItemUpdate -= OnAccountValue;
                        // One final read for an account that just disconnected; never
                        // repeatedly scan the hundreds of already inactive accounts.
                        RecoverAccount(closing, true);
                        lock (valueGate) { observedItems.Remove(key); }
                        recovery.Remove(key);
                        accounts.Remove(key);
                        nextStateUtc = DateTime.MinValue;
                    }
                }
                foreach (Account current in available)
                    if (!accounts.ContainsKey(current.Name))
                    {
                        current.ExecutionUpdate += OnExecution;
                        if (!simulatorOnly) current.AccountItemUpdate += OnAccountValue;
                        accounts.Add(current.Name, current);
                        recovery[current.Name] = new RecoveryState();
                        nextStateUtc = DateTime.MinValue;
                    }
                accountCount = accounts.Count;
                return accounts.Values.ToArray();
            }
        }

        private void OnAccountStatus(object sender, AccountStatusEventArgs e)
        {
            if (!accepting || Interlocked.Exchange(ref statusRefreshQueued, 1) != 0) return;
            System.Threading.Timer timer = reconcile;
            try { if (timer != null) timer.Change(0, 30000); }
            catch (ObjectDisposedException) { }
        }

        private void OnExecution(object sender, ExecutionEventArgs e)
        {
            if (!accepting) return;
            try { CaptureExecution(e.Execution, e.Quantity, e.Price); }
            catch (Exception error) { Warn("Execution capture: " + error.Message); }
        }

        private void RecoverAccount(Account account, bool force)
        {
            try
            {
                DateTime now = DateTime.UtcNow;
                RecoveryState state;
                if (!recovery.TryGetValue(account.Name, out state)) { state = new RecoveryState(); recovery[account.Name] = state; }
                byte retry;
                force = recoveryNeeded.TryRemove(account.Name, out retry) || force;
                if (!force && now < state.NextCheckUtc) return;
                state.NextCheckUtc = now.AddSeconds(60);
                Execution[] current;
                lock (account.Executions)
                {
                    int count = account.Executions.Count;
                    if (!force && count == state.Count && now < state.NextFullUtc) return;
                    current = account.Executions.ToArray();
                    state.Count = count;
                }
                state.NextFullUtc = now.AddMinutes(5);
                foreach (Execution execution in current) CaptureExecution(execution, execution.Quantity, execution.Price);
            }
            catch (Exception error) { Warn("Session recovery for " + account.Name + ": " + error.Message); }
        }

        private void SnapshotExecutions()
        {
            if (!accepting || Interlocked.Exchange(ref snapshotBusy, 1) != 0) return;
            try
            {
                lock (snapshotGate)
                {
                if (!accepting) return;
                Account[] currentAccounts = SynchronizeAccounts();
                if (!simulatorOnly && DateTime.UtcNow >= nextStateUtc)
                {
                    XDocument state = CaptureAccountState(currentAccounts, true);
                    if (Enqueue(delegate { SaveAccountState(state); })) nextStateUtc = DateTime.UtcNow.AddSeconds(60);
                }
                foreach (Account account in currentAccounts) RecoverAccount(account, false);
                Feed[] currentFeeds;
                lock (feeds) currentFeeds = feeds.ToArray();
                foreach (Feed feed in currentFeeds)
                {
                    if (feed.Ready) CaptureClosedBars(feed);
                    else if (feed.Failed && DateTime.UtcNow >= feed.RetryAfterUtc && accepting)
                    {
                        lock (feeds) feeds.Remove(feed);
                        try { feed.Request.Update -= feed.Handler; feed.Request.Dispose(); } catch { }
                        if (accepting) RequestPrices(feed.Instrument);
                    }
                }
                }
            }
            catch (Exception error) { Warn("Session recovery: " + error.Message); }
            finally { Interlocked.Exchange(ref statusRefreshQueued, 0); Interlocked.Exchange(ref snapshotBusy, 0); }
        }

        private void OnAccountValue(object sender, AccountItemEventArgs e)
        {
            if (!accepting || simulatorOnly || e.Account == null || !EligibleAccount(e.Account.Name)
                || !stateItems.Contains(e.AccountItem) || e.Currency != e.Account.Denomination
                || Double.IsNaN(e.Value) || Double.IsInfinity(e.Value)) return;
            lock (valueGate)
            {
                HashSet<AccountItem> items;
                if (!observedItems.TryGetValue(e.Account.Name, out items))
                { items = new HashSet<AccountItem>(); observedItems.Add(e.Account.Name, items); }
                items.Add(e.AccountItem);
            }
        }

        private XDocument CaptureAccountState(Account[] currentAccounts, bool running)
        {
            DateTime now = DateTime.UtcNow;
            XElement root = new XElement("TradebookAccountState", new XAttribute("schemaVersion", "1"),
                new XAttribute("mode", "AccountsReadOnly"), new XAttribute("recorderVersion", "0.4.1"),
                new XAttribute("capturedAtUtc", Stamp(now)), new XAttribute("running", running ? "true" : "false"),
                new XAttribute("scopePrefixes", String.Join(";", accountPrefixes)));
            foreach (Account account in currentAccounts)
            {
                if (!EligibleAccount(account.Name)) continue;
                try
                {
                    Connection connection = account.Connection;
                    bool connected = connection != null && connection.Status == ConnectionStatus.Connected;
                    string denomination = account.Denomination == Currency.UsDollar ? "USD" : account.Denomination.ToString();
                    XElement row = new XElement("Account", new XAttribute("name", account.Name),
                        new XAttribute("currency", denomination), new XAttribute("connected", connected ? "true" : "false"),
                        new XAttribute("connection", connection == null || connection.Options == null ? "" : connection.Options.Name),
                        new XAttribute("provider", connection == null || connection.Options == null ? "" : connection.Options.Provider.ToString()),
                        new XAttribute("positionsAvailable", "false"));
                    if (connected)
                    {
                        foreach (AccountItem item in stateItems)
                        {
                            try
                            {
                                double value = account.Get(item, account.Denomination);
                                if (Double.IsNaN(value) || Double.IsInfinity(value)) continue;
                                bool supported;
                                lock (valueGate)
                                {
                                    HashSet<AccountItem> seen;
                                    if (!observedItems.TryGetValue(account.Name, out seen))
                                    { seen = new HashSet<AccountItem>(); observedItems.Add(account.Name, seen); }
                                    // A nonzero platform read or an actual update proves this item exists.
                                    // Initial zero without either remains unavailable, not a reported zero.
                                    if (value != 0) seen.Add(item);
                                    supported = seen.Contains(item);
                                }
                                if (!supported) continue;
                                row.Add(new XElement("Value", new XAttribute("item", item.ToString()),
                                    new XAttribute("value", value.ToString("R", Invariant)),
                                    new XAttribute("observedAtUtc", Stamp(now)),
                                    new XAttribute("source", "PlatformRead")));
                            }
                            catch { /* An unavailable provider value is omitted. */ }
                        }
                        try
                        {
                            List<XElement> positions = new List<XElement>();
                            lock (account.Positions)
                            {
                                foreach (NinjaTrader.Cbi.Position position in account.Positions)
                                {
                                    if (position.Quantity == 0 || position.MarketPosition == MarketPosition.Flat) continue;
                                    if (position.Instrument == null || Double.IsNaN(position.AveragePrice) || Double.IsInfinity(position.AveragePrice))
                                        throw new InvalidOperationException("A position has no instrument or average price.");
                                    positions.Add(new XElement("Position", new XAttribute("instrument", position.Instrument.FullName),
                                        new XAttribute("side", position.MarketPosition.ToString()), new XAttribute("quantity", position.Quantity),
                                        new XAttribute("averagePrice", position.AveragePrice.ToString("R", Invariant))));
                                }
                            }
                            row.Add(positions);
                            row.SetAttributeValue("positionsAvailable", "true");
                        }
                        catch { /* Do not display a failed position read as flat. */ }
                    }
                    else lock (valueGate) { observedItems.Remove(account.Name); }
                    root.Add(row);
                }
                catch
                {
                    // Keep the account visible when a provider read fails, without inventing values.
                    root.Add(new XElement("Account", new XAttribute("name", account.Name), new XAttribute("currency", "Unknown"),
                        new XAttribute("connected", "false"), new XAttribute("connection", ""), new XAttribute("provider", ""),
                        new XAttribute("positionsAvailable", "false")));
                }
            }
            return new XDocument(root);
        }

        private void SaveAccountState(XDocument state)
        {
            string path = Path.Combine(OutputFolder, "account-state.tradebook.xml");
            string temporary = path + ".writing";
            state.Save(temporary);
            if (File.Exists(path)) File.Replace(temporary, path, path + ".previous");
            else File.Move(temporary, path);
        }

        private void CaptureExecution(Execution execution, int quantity, double price)
        {
            if (!accepting || execution == null || execution.Account == null || !EligibleAccount(execution.Account.Name)) return;
            string instrument = execution.Instrument == null ? "" : execution.Instrument.FullName;
            if (!System.Text.RegularExpressions.Regex.IsMatch(instrument, @"^(MNQ|NQ|MES|ES) (0[1-9]|1[0-2])-\d{2}$", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return;
            if (String.IsNullOrEmpty(execution.ExecutionId)) { Warn("A fill has no execution ID; it was not exported."); return; }
            if (quantity <= 0 || Double.IsNaN(price) || Double.IsInfinity(price) || price <= 0)
            { Warn("An execution removal or invalid update needs manual review: " + execution.ExecutionId); return; }
            string action, actionSource;
            if (execution.Order != null) { action = execution.Order.OrderAction.ToString(); actionSource = "OrderAction"; }
            else
            {
                if (execution.MarketPosition == MarketPosition.Long) action = "Buy";
                else if (execution.MarketPosition == MarketPosition.Short) action = "Sell";
                else { Warn("Fill direction unavailable: " + execution.ExecutionId); return; }
                actionSource = "ExecutionMarketPosition";
            }
            // Freeze primitive values while the event object is valid. No XML,
            // timezone conversion, disk access or history traversal on this callback.
            ExecutionCopy copy = new ExecutionCopy(execution.Account.Name, instrument, execution.ExecutionId, action,
                actionSource, quantity, price, execution.Time, execution.OrderId ?? "", execution.Commission,
                Convert.ToString(execution.Position, Invariant));
            lock (executionGate)
            {
                ExecutionCopy prior;
                if (queuedExecutions.TryGetValue(copy.Key, out prior) && prior.SameAs(copy)) return;
                if (Enqueue(delegate { ProcessExecution(copy); }))
                {
                    if (queuedExecutions.Count >= 50000) queuedExecutions.Clear();
                    queuedExecutions[copy.Key] = copy;
                }
                else recoveryNeeded[copy.Account] = 0;
            }
        }

        private void ProcessExecution(ExecutionCopy copy)
        {
            DateTime utc;
            try { utc = ToUtc(copy.Time); }
            catch (Exception error)
            {
                Warn("Fill time needs review for " + copy.Account + " / " + copy.Id + ": " + error.Message);
                return;
            }
            XElement record = new XElement("Execution",
                new XAttribute("key", copy.Key), new XAttribute("Account", copy.Account), new XAttribute("Instrument", copy.Instrument),
                new XAttribute("ID", copy.Id), new XAttribute("Action", copy.Action), new XAttribute("Quantity", copy.Quantity),
                new XAttribute("Price", copy.Price.ToString("R", Invariant)), new XAttribute("Time", Stamp(utc)),
                new XAttribute("OrderID", copy.OrderId), new XAttribute("CommissionReported", copy.Commission.ToString("R", Invariant)),
                new XAttribute("RawAccountPosition", copy.Position), new XAttribute("ActionSource", copy.ActionSource),
                new XAttribute("SourceTime", copy.Time.ToString("yyyy-MM-ddTHH:mm:ss.fffffff", Invariant)), new XAttribute("SourceTimeZone", sourceZone.Id));
            if (GetDay(Day(utc)).Put(record)) Interlocked.Increment(ref observedFills);
        }

        private sealed class ExecutionCopy
        {
            internal readonly string Account, Instrument, Id, Action, ActionSource, OrderId, Position, Key;
            internal readonly int Quantity;
            internal readonly double Price, Commission;
            internal readonly DateTime Time;
            internal ExecutionCopy(string account, string instrument, string id, string action, string actionSource, int quantity,
                double price, DateTime time, string orderId, double commission, string position)
            {
                Account = account; Instrument = instrument; Id = id; Action = action; ActionSource = actionSource;
                Quantity = quantity; Price = price; Time = time; OrderId = orderId; Commission = commission; Position = position;
                Key = "fill|" + account + "|" + instrument + "|" + id;
            }
            internal bool SameAs(ExecutionCopy other)
            {
                return Quantity == other.Quantity && Price.Equals(other.Price) && Time == other.Time && Time.Kind == other.Time.Kind
                    && Commission.Equals(other.Commission) && Action == other.Action && ActionSource == other.ActionSource
                    && OrderId == other.OrderId && Position == other.Position;
            }
        }

        private sealed class RecoveryState
        {
            internal int Count = -1;
            internal DateTime NextCheckUtc;
            internal DateTime NextFullUtc;
        }

        private void RequestPrices(string contract)
        {
            DateTime now = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, sourceZone);
            Feed feed = new Feed();
            feed.Instrument = contract;
            feed.Request = new BarsRequest(Instrument.GetInstrument(contract), now.Date.AddDays(-historyDays), now);
            feed.Request.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Minute, Value = 1 };
            feed.Request.TradingHours = TradingHours.Get("Default 24 x 7");
            feed.Request.MergePolicy = MergePolicy.DoNotMerge;
            feed.Request.LookupPolicy = LookupPolicies.Provider;
            feed.Handler = delegate(object sender, BarsUpdateEventArgs e) { if (feed.Ready) CaptureClosedBars(feed); };
            feed.Request.Update += feed.Handler;
            lock (feeds) { if (!accepting) { feed.Request.Dispose(); return; } feeds.Add(feed); }
            feed.Request.Request(new Action<BarsRequest, ErrorCode, string>(delegate(BarsRequest request, ErrorCode code, string error)
            {
                if (!accepting) return;
                if (code != ErrorCode.NoError) { feed.RetryAfterUtc = DateTime.UtcNow.AddMinutes(1); feed.Failed = true; SetMessage("Waiting for prices for " + contract + ": " + code + " " + error + ". Retries in about one minute; execution recording continues."); return; }
                feed.Ready = true;
                SetMessage("Light recording; fills save about every 10 seconds; optional minute prices are enabled.");
                CaptureClosedBars(feed);
            }));
        }

        private void CaptureClosedBars(Feed feed)
        {
            if (!accepting) return;
            try
            {
                lock (feed.Gate)
                {
                    // Minute exports do not need to scan on every market-data tick.
                    if (DateTime.UtcNow < feed.NextReadUtc) return;
                    feed.NextReadUtc = DateTime.UtcNow.AddSeconds(5);
                    int last = feed.Request.Bars.Count - 1;
                    // Finalize a minute from its end timestamp, also when no next tick
                    // arrives at a session close. The timer checks this every 30 seconds.
                    DateTime cutoff = DateTime.UtcNow.AddSeconds(-2);
                    while (last >= 0 && ToUtc(feed.Request.Bars.GetTime(last)) > cutoff) last--;
                    if (last < feed.LastClosed) feed.LastClosed = -1; // Re-read after a series reset; keys de-duplicate.
                    if (last <= feed.LastClosed) return;
                    if (last - feed.LastClosed > 25000) { Warn("Unexpected price-history size; restart this test with a shorter request."); return; }
                    List<KeyValuePair<string, XElement>> records = new List<KeyValuePair<string, XElement>>();
                    for (int i = feed.LastClosed + 1; i <= last; i++)
                    {
                        DateTime raw = feed.Request.Bars.GetTime(i);
                        DateTime end = ToUtc(raw);
                        XElement record = new XElement("MinuteBar",
                            new XAttribute("key", "bar|" + feed.Instrument + "|" + Stamp(end)),
                            new XAttribute("Instrument", feed.Instrument), new XAttribute("IntervalSeconds", 60),
                            new XAttribute("BarEndUtc", Stamp(end)), new XAttribute("TimestampConvention", "end-of-bar"),
                            new XAttribute("Open", feed.Request.Bars.GetOpen(i).ToString("R", Invariant)),
                            new XAttribute("High", feed.Request.Bars.GetHigh(i).ToString("R", Invariant)),
                            new XAttribute("Low", feed.Request.Bars.GetLow(i).ToString("R", Invariant)),
                            new XAttribute("Close", feed.Request.Bars.GetClose(i).ToString("R", Invariant)),
                            new XAttribute("Volume", feed.Request.Bars.GetVolume(i)),
                            new XAttribute("SourceTime", raw.ToString("yyyy-MM-ddTHH:mm:ss.fffffff", Invariant)),
                            new XAttribute("SourceTimeZone", sourceZone.Id), new XAttribute("TradingHours", "Default 24 x 7"),
                            new XAttribute("MergePolicy", "DoNotMerge"));
                        records.Add(new KeyValuePair<string, XElement>(Day(end.AddMinutes(-1)), record));
                    }
                    if (Enqueue(delegate
                    {
                        foreach (KeyValuePair<string, XElement> record in records)
                            if (GetDay(record.Key).Put(record.Value)) Interlocked.Increment(ref observedBars);
                    })) feed.LastClosed = last;
                }
            }
            catch (Exception error) { Warn("Price capture for " + feed.Instrument + ": " + error.Message); }
        }

        private DateTime ToUtc(DateTime value)
        {
            if (value.Kind == DateTimeKind.Utc) return value;
            DateTime wallTime = DateTime.SpecifyKind(value, DateTimeKind.Unspecified);
            if (sourceZone.IsAmbiguousTime(wallTime) || sourceZone.IsInvalidTime(wallTime))
                throw new InvalidOperationException("Ambiguous or invalid platform timestamp " + value.ToString("O") + ". No time was guessed.");
            return TimeZoneInfo.ConvertTimeToUtc(wallTime, sourceZone);
        }

        private string Day(DateTime utc) { return TimeZoneInfo.ConvertTimeFromUtc(utc, dayZone).ToString("yyyy-MM-dd", Invariant); }
        private static string Stamp(DateTime utc) { return utc.ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ", Invariant); }
        private void SetMessage(string value) { lock (messageGate) message = value; }
        private void Warn(string value)
        {
            Interlocked.Increment(ref warnings);
            if (issueLog.Count < 1000) issueLog.Enqueue(value);
            SetMessage("CHECK CAPTURE: " + value);
        }

        private bool Enqueue(Action action)
        {
            if (!accepting) return false;
            try
            {
                if (work.TryAdd(action)) return true;
                Warn("The save queue is full. This run may be incomplete; stop, restart and compare the session's fills.");
                return false;
            }
            catch (InvalidOperationException) { return false; }
        }

        private CaptureDay GetDay(string day)
        {
            CaptureDay found;
            if (!days.TryGetValue(day, out found))
            {
                // Keep memory bounded if the test window is left running for many days.
                if (days.Count >= 10)
                {
                    string oldest = days.Keys.OrderBy(k => k, StringComparer.Ordinal).First();
                    days[oldest].Save(sourceZone.Id, warnings, true);
                    days.Remove(oldest);
                }
                found = new CaptureDay(day, OutputFolder, simulatorOnly);
                days.Add(day, found);
            }
            return found;
        }

        private void WriteLoop()
        {
            DateTime lastSave = DateTime.UtcNow;
            try
            {
                while (!work.IsCompleted)
                {
                    Action action;
                    if (work.TryTake(out action, 250)) action();
                    if ((DateTime.UtcNow - lastSave).TotalSeconds >= 10)
                    {
                        SaveDays();
                        lastSave = DateTime.UtcNow;
                    }
                }
                SaveDays(true);
            }
            catch (Exception error)
            {
                Warn("File writer failed: " + error.Message + ". Stop the recorder; the last saved files are retained. This run is incomplete.");
                accepting = false;
                throw;
            }
        }

        private void SaveDays(bool exportCsv = false)
        {
            string issue;
            while (issueLog.TryDequeue(out issue)) GetDay(Day(DateTime.UtcNow)).AddIssue(issue);
            foreach (CaptureDay day in days.Values) day.Save(sourceZone.Id, warnings, exportCsv);
        }

        internal void StopAndSave()
        {
            if (Interlocked.Exchange(ref stopStarted, 1) != 0) return;
            Account[] closingAccounts = new Account[0];
            try
            {
                Account.AccountStatusUpdate -= OnAccountStatus;
                if (reconcile != null) { reconcile.Dispose(); reconcile = null; }
                // Finish any in-flight snapshot before draining. This method is run
                // on a background task by the window, never on NinjaTrader's UI.
                lock (snapshotGate)
                {
                    lock (accountGate)
                    {
                        closingAccounts = accounts.Values.ToArray();
                        foreach (Account account in closingAccounts)
                        {
                            account.ExecutionUpdate -= OnExecution;
                            account.AccountItemUpdate -= OnAccountValue;
                        }
                    }
                    // Catch fills whose live notification was missed just before stop.
                    // Retry a full queue briefly while the writer is still draining it.
                    DateTime deadline = DateTime.UtcNow.AddSeconds(5);
                    do
                    {
                        foreach (Account account in closingAccounts) RecoverAccount(account, true);
                        if (recoveryNeeded.IsEmpty) break;
                        Thread.Sleep(25);
                    } while (DateTime.UtcNow < deadline);
                    if (!recoveryNeeded.IsEmpty) Warn("Some fills still need recovery. Compare this capture with NinjaTrader or import an execution export.");
                    lock (executionGate) { accepting = false; work.CompleteAdding(); }
                    lock (accountGate) { accounts.Clear(); accountCount = 0; }
                    Feed[] closingFeeds;
                    lock (feeds) { closingFeeds = feeds.ToArray(); feeds.Clear(); }
                    foreach (Feed feed in closingFeeds)
                    {
                        try { feed.Request.Update -= feed.Handler; feed.Request.Dispose(); }
                        catch (Exception error) { Warn("Subscription cleanup: " + error.Message); }
                    }
                    if (writer != null) writer.GetAwaiter().GetResult();
                    if (!simulatorOnly) SaveAccountState(CaptureAccountState(closingAccounts, false));
                }
                if (warnings == 0) SetMessage("Saved. Compare captured fills with NinjaTrader; Tradebook imports account files through the connected browser.");
            }
            finally
            {
                accepting = false;
                // Also drain if subscription cleanup failed before the normal stop path.
                if (!work.IsAddingCompleted) work.CompleteAdding();
                try { if (writer != null && !writer.IsCompleted) writer.GetAwaiter().GetResult(); }
                catch { /* The writer reports its error in Status; preserve the stop error. */ }
                if (fileLock != null) { fileLock.Dispose(); fileLock = null; }
                stopped = true;
            }
        }

        private sealed class Feed
        {
            internal readonly object Gate = new object();
            internal string Instrument;
            internal BarsRequest Request;
            internal EventHandler<BarsUpdateEventArgs> Handler;
            internal volatile bool Ready;
            internal volatile bool Failed;
            internal DateTime RetryAfterUtc;
            internal DateTime NextReadUtc;
            internal int LastClosed = -1;
        }

        private sealed class CaptureDay
        {
            private readonly string day;
            private readonly string folder;
            private readonly bool simulatorOnly;
            private readonly Dictionary<string, XElement> records = new Dictionary<string, XElement>(StringComparer.Ordinal);
            private readonly List<XElement> revisions = new List<XElement>();
            private readonly List<XElement> issues = new List<XElement>();
            private long lastExecutionSequence;
            private bool dirty;
            private int savedWarnings = -1;

            private string Stem { get { return day + (simulatorOnly ? "" : ".accounts"); } }
            internal CaptureDay(string value, string output, bool simOnly)
            {
                day = value;
                folder = output;
                simulatorOnly = simOnly;
                string path = Path.Combine(folder, Stem + ".tradebook.xml");
                if (!File.Exists(path)) return;
                if (new FileInfo(path).Length > 25000000) throw new InvalidDataException("Existing capture exceeds the prototype's file-size limit: " + path);
                XmlReaderSettings settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 25000000 };
                XDocument document;
                using (XmlReader reader = XmlReader.Create(path, settings)) document = XDocument.Load(reader);
                XElement root = document.Root;
                if (root == null || root.Name != "TradebookCapture" || (string)root.Attribute("schemaVersion") != "1" || (string)root.Attribute("mode") != (simulatorOnly ? "Sim101Only" : "AccountsReadOnly"))
                    throw new InvalidDataException("Unrecognized capture file; it was not overwritten: " + path);
                XElement saved = root.Element("Records");
                if (saved != null) foreach (XElement record in saved.Elements()) records.Add((string)record.Attribute("key"), new XElement(record));
                lastExecutionSequence = records.Values.Where(r => r.Name == "Execution").Select(r => (long?)r.Attribute("Sequence") ?? 0).DefaultIfEmpty(0).Max();
                XElement priorRevisions = root.Element("Revisions");
                if (priorRevisions != null) revisions.AddRange(priorRevisions.Elements().Select(r => new XElement(r)));
                XElement priorIssues = root.Element("Issues");
                if (priorIssues != null) issues.AddRange(priorIssues.Elements().Select(r => new XElement(r)));
            }

            internal bool Put(XElement record)
            {
                string key = (string)record.Attribute("key");
                XElement old;
                if (records.TryGetValue(key, out old))
                {
                    if (record.Name == "Execution") record.SetAttributeValue("Sequence", (long?)old.Attribute("Sequence") ?? ++lastExecutionSequence);
                    if (XNode.DeepEquals(old, record)) return false;
                    revisions.Add(new XElement("Revision", new XAttribute("observedAtUtc", Stamp(DateTime.UtcNow)), new XElement("Before", new XElement(old)), new XElement("After", new XElement(record))));
                }
                else if (record.Name == "Execution") record.SetAttributeValue("Sequence", ++lastExecutionSequence);
                records[key] = record;
                dirty = true;
                return true;
            }

            internal void AddIssue(string issue)
            {
                issues.Add(new XElement("Issue", new XAttribute("observedAtUtc", Stamp(DateTime.UtcNow)), issue));
                dirty = true;
            }

            internal void Save(string sourceTimeZone, int warningCount, bool exportCsv)
            {
                if (!dirty && warningCount == savedWarnings)
                {
                    if (exportCsv) SaveCsv();
                    return;
                }
                XElement root = new XElement("TradebookCapture",
                    new XAttribute("schemaVersion", "1"), new XAttribute("recorderVersion", "0.4.1"),
                    new XAttribute("mode", simulatorOnly ? "Sim101Only" : "AccountsReadOnly"), new XAttribute("day", day),
                    new XAttribute("dayTimeZone", "America/Chicago"), new XAttribute("platformTimeZone", sourceTimeZone),
                    new XAttribute("savedAtUtc", Stamp(DateTime.UtcNow)), new XAttribute("warningCountThisRun", warningCount),
                    new XAttribute("cloudSync", "browser-folder"),
                    new XElement("Records", records.OrderBy(r => r.Key, StringComparer.Ordinal).Select(r => new XElement(r.Value))),
                    new XElement("Revisions", revisions.Select(r => new XElement(r))),
                    new XElement("Issues", issues.Select(r => new XElement(r))));
                string path = Path.Combine(folder, Stem + ".tradebook.xml");
                string temporary = path + ".writing";
                XmlWriterSettings settings = new XmlWriterSettings { Indent = true, Encoding = new UTF8Encoding(false) };
                using (XmlWriter xml = XmlWriter.Create(temporary, settings)) new XDocument(root).Save(xml);
                AtomicReplace(temporary, path);
                savedWarnings = warningCount;
                dirty = false;
                if (exportCsv) SaveCsv();
            }

            private void SaveCsv()
            {
                // CSV is an on-stop companion export, not another full rewrite per fill.
                string csvPath = Path.Combine(folder, Stem + ".executions.csv");
                using (StreamWriter csv = new StreamWriter(csvPath + ".writing", false, new UTF8Encoding(false)))
                {
                    csv.WriteLine("Account,Instrument,ID,Action,Quantity,Price,Time,OrderID,CommissionReported,Position");
                    foreach (XElement fill in records.Values.Where(r => r.Name == "Execution").OrderBy(r => (string)r.Attribute("Time"), StringComparer.Ordinal).ThenBy(r => (long?)r.Attribute("Sequence") ?? 0))
                    {
                        string[] columns = { "Account", "Instrument", "ID", "Action", "Quantity", "Price", "Time", "OrderID", "CommissionReported", "RawAccountPosition" };
                        csv.WriteLine(String.Join(",", columns.Select(column => Csv((string)fill.Attribute(column) ?? ""))));
                    }
                }
                AtomicReplace(csvPath + ".writing", csvPath);
            }

            private static void AtomicReplace(string temporary, string destination)
            {
                if (File.Exists(destination)) File.Replace(temporary, destination, destination + ".previous");
                else File.Move(temporary, destination);
            }

            private static string Csv(string text) { return "\"" + text.Replace("\"", "\"\"") + "\""; }
        }
    }
}
