// Temporary passive diagnostic. No failure classification or trading actions.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript;

namespace NinjaTrader.NinjaScript.Indicators
{
    public class TradebookAccountDiagnostic : Indicator
    {
        private const int MaxAccounts = 50;
        private const int MaxLines = 250;
        private const int MaxMembers = 24;
        private readonly object gate = new object();
        private readonly HashSet<Account> watched = new HashSet<Account>();
        private volatile bool observing;
        private int lines;

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Name = "TradebookAccountDiagnostic";
                Description = "Temporary raw account metadata diagnostic; never classifies failure or trades.";
                Calculate = Calculate.OnBarClose;
                IsOverlay = true;
                DisplayInDataBox = false;
                PaintPriceMarkers = false;
                IsSuspendedWhileInactive = false;
            }
            else if (State == State.DataLoaded)
                StartObservation();
            else if (State == State.Terminated)
                StopObservation();
        }

        protected override void OnBarUpdate() { }

        private void StartObservation()
        {
            lock (gate)
            {
                if (observing) return;
                observing = true;
                lines = 0;
                Account.AccountStatusUpdate += OnNativeStatus;
            }
            Write("REPORT", "BEGIN v1 | raw evidence only; lock cause UNKNOWN. Profit lockouts, DLL and firm restrictions must be compared separately.");
            Write("REPORT", "One instance inspects connected LFE/LFF accounts. No tick polling, account changes, network access, files or test orders.");
            ReportStatusSchema();
            try
            {
                Account[] accounts;
                lock (Account.All) accounts = Account.All.ToArray();
                Account[] eligible = accounts.Where(InScope).Where(IsConnected).OrderBy(a => a.Name).ToArray();
                Write("REPORT", "Connected matching accounts=" + eligible.Length + "; inspecting at most " + MaxAccounts + ". Connected does not mean trading is allowed.");
                foreach (Account account in eligible.Take(MaxAccounts))
                    if (Watch(account)) ReportAccount(account, "initial");
                Write("REPORT", "INITIAL END | missing flags/reasons mean UNKNOWN. Later status events and already-occurring rejected orders may add evidence. Remove the indicator to stop.");
            }
            catch (Exception error) { Write("REPORT", "Initial inspection unavailable: " + error.GetType().Name); }
        }

        private void StopObservation()
        {
            lock (gate)
            {
                observing = false;
                Account.AccountStatusUpdate -= OnNativeStatus;
                foreach (Account account in watched)
                    account.OrderUpdate -= OnNativeOrder;
                watched.Clear();
            }
        }

        private static bool InScope(Account account)
        {
            return account != null && !String.IsNullOrEmpty(account.Name)
                && (account.Name.StartsWith("LFE", StringComparison.OrdinalIgnoreCase)
                    || account.Name.StartsWith("LFF", StringComparison.OrdinalIgnoreCase));
        }

        private static bool IsConnected(Account account)
        {
            try { return account.Connection != null && account.Connection.Status == ConnectionStatus.Connected; }
            catch { return false; }
        }

        private bool Watch(Account account)
        {
            if (!InScope(account)) return false;
            lock (gate)
            {
                if (!observing || watched.Contains(account) || watched.Count >= MaxAccounts) return false;
                account.OrderUpdate += OnNativeOrder;
                watched.Add(account);
                return true;
            }
        }

        private void OnNativeStatus(object sender, AccountStatusEventArgs e)
        {
            if (!HasBudget()) return;
            try
            {
                if (e == null || !InScope(e.Account)) return;
                Write(e.Account.Name, "AccountStatusUpdate raw=" + e.Status + " | cause UNKNOWN");
                if (Watch(e.Account)) ReportAccount(e.Account, "newly observed");
                else Write(e.Account.Name, "Account.public after status | " + ReadMembers(e.Account, false));
            }
            catch (Exception error) { Write("REPORT", "Status inspection unavailable: " + error.GetType().Name); }
        }

        private void OnNativeOrder(object sender, OrderEventArgs e)
        {
            if (!HasBudget()) return;
            try
            {
                if (e == null || e.Order == null || e.OrderState != OrderState.Rejected) return;
                Account account = e.Order.Account;
                if (!InScope(account)) return;
                Write(account.Name, "OrderUpdate rejected (cause NOT classified) | " + ReadMembers(e, true));
            }
            catch (Exception error) { Write("REPORT", "Rejection inspection unavailable: " + error.GetType().Name); }
        }

        private void ReportAccount(Account account, string source)
        {
            if (!HasBudget()) return;
            Write(account.Name, source + " | connection=" + (IsConnected(account) ? "Connected" : "Not connected")
                + " | Account.public | " + ReadMembers(account, false));
            try
            {
                // Bound work before filtering. This is a small sample, not a log/history search.
                Order[] sample;
                lock (account.Orders) sample = account.Orders.Take(200).ToArray();
                Order[] rejected = sample.Where(order => order.OrderState == OrderState.Rejected).Take(3).ToArray();
                Write(account.Name, "Loaded-order sample=" + sample.Length + "; rejected shown=" + rejected.Length
                    + " (max 200 inspected / 3 shown; absence proves nothing)");
                foreach (Order order in rejected)
                    Write(account.Name, "Previously loaded rejection | " + ReadMembers(order, true));
            }
            catch (Exception error) { Write(account.Name, "Loaded orders unavailable: " + error.GetType().Name); }
        }

        private void ReportStatusSchema()
        {
            try
            {
                Type type = typeof(AccountStatusEventArgs);
                PropertyInfo property = type.GetProperty("Status", BindingFlags.Public | BindingFlags.Instance);
                FieldInfo field = type.GetField("Status", BindingFlags.Public | BindingFlags.Instance);
                Type statusType = property != null ? property.PropertyType : field != null ? field.FieldType : null;
                Write("REPORT", "AccountStatusUpdate schema=" + (statusType == null ? "not exposed" : statusType.FullName)
                    + (statusType != null && statusType.IsEnum ? "; allowed raw values=" + String.Join(",", Enum.GetNames(statusType).Take(30).ToArray()) : ""));
            }
            catch (Exception error) { Write("REPORT", "Status schema unavailable: " + error.GetType().Name); }
        }

        private static bool Relevant(string name, bool rejection)
        {
            string lower = name.ToLowerInvariant();
            if (new[] { "password", "token", "secret", "credential", "auth", "key" }.Any(lower.Contains)) return false;
            string[] words = rejection
                ? new[] { "error", "comment", "reason", "reject", "message", "orderstate", "time" }
                : new[] { "status", "state", "risk", "lock", "enabled", "disabled", "trading", "liquidat", "drawdown", "losslimit", "profitlimit" };
            return words.Any(lower.Contains);
        }

        private static bool Scalar(Type type)
        {
            type = Nullable.GetUnderlyingType(type) ?? type;
            return type.IsEnum || type == typeof(string) || type == typeof(bool) || type == typeof(DateTime)
                || type == typeof(int) || type == typeof(long) || type == typeof(double) || type == typeof(decimal);
        }

        private static string ReadMembers(object target, bool rejection)
        {
            // Discovery only: public scalar getters/fields. Never write a member or invoke risk/trading methods.
            Type type = target.GetType();
            IEnumerable<MemberInfo> members = type.GetProperties(BindingFlags.Public | BindingFlags.Instance).Cast<MemberInfo>()
                .Concat(type.GetFields(BindingFlags.Public | BindingFlags.Instance).Cast<MemberInfo>());
            List<string> values = new List<string>();
            foreach (MemberInfo member in members.Where(m => Relevant(m.Name, rejection)).OrderBy(m => m.Name).Take(MaxMembers))
            {
                PropertyInfo property = member as PropertyInfo;
                FieldInfo field = member as FieldInfo;
                if (property != null && (property.GetGetMethod() == null || property.GetIndexParameters().Length != 0)) continue;
                Type valueType = property != null ? property.PropertyType : field.FieldType;
                if (!Scalar(valueType)) { values.Add(member.Name + "=<" + valueType.Name + "; not read>"); continue; }
                try
                {
                    object value = property != null ? property.GetValue(target, null) : field.GetValue(target);
                    values.Add(member.Name + "=" + Clean(value == null ? "null" : Convert.ToString(value, CultureInfo.InvariantCulture), 240));
                }
                catch (Exception error) { values.Add(member.Name + "=<unavailable:" + error.GetType().Name + ">"); }
            }
            return values.Count == 0 ? "No matching public scalar status/reason fields exposed; cause UNKNOWN" : String.Join("; ", values.ToArray());
        }

        private static string Clean(string value, int length)
        {
            string text = value ?? "";
            string cleaned = new String(text.Substring(0, Math.Min(length, text.Length)).Select(c => Char.IsControl(c) ? ' ' : c).ToArray());
            return text.Length > length ? cleaned + " [truncated]" : cleaned;
        }

        private bool HasBudget() { return observing && Volatile.Read(ref lines) <= MaxLines; }

        private void Write(string account, string message)
        {
            if (!observing) return;
            int sequence = Interlocked.Increment(ref lines);
            if (sequence > MaxLines + 1) return;
            if (sequence == MaxLines + 1) message = "OUTPUT LIMIT REACHED. Remove and re-add the indicator for a new report; no account action was taken.";
            try
            {
                NinjaTrader.Code.Output.Process("[Tradebook diagnostic] " + DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
                    + " | " + Clean(account, 160) + " | " + Clean(message, 1800), NinjaTrader.NinjaScript.PrintTo.OutputTab2);
            }
            catch { /* Diagnostic output failure must not affect the platform's order/event processing. */ }
        }
    }
}
