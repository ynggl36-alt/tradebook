"""Parse the shipped C# and check critical passive-capture boundaries.

Requires tree-sitter and tree-sitter-c-sharp; these are validation tools only.
This does not replace compilation against NinjaTrader's Windows assemblies.
"""
import json,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'.sites-runtime/validation-python'))
from tree_sitter import Language,Parser
import tree_sitter_c_sharp
source=(root/'public/recorder/TradebookRecorder.cs').read_bytes()
tree=Parser(Language(tree_sitter_c_sharp.language())).parse(source)
def descendants(node):
    yield node
    for child in node.children:
        yield from descendants(child)
def code(node):
    return source[node.start_byte:node.end_byte].decode()
errors=[(n.type,n.start_point) for n in descendants(tree.root_node) if n.type=='ERROR' or n.is_missing]
assert not errors,errors
methods={code(n.child_by_field_name('name')):n for n in descendants(tree.root_node) if n.type=='method_declaration'}
def method(name):
    return code(methods[name])
callback=method('CaptureExecution')
forbidden=['new XElement','new XDocument','ToUtc(','.Save(', 'File.','CaptureAccountState(','.Executions','Thread.Sleep']
assert not any(word in callback for word in forbidden),'Heavy work entered the execution callback'
assert 'new ExecutionCopy(' in callback and 'ProcessExecution(copy)' in callback
assert '^(MNQ|NQ|MES|ES)' in callback and '!instruments.Contains' not in callback,'Execution coverage must include all supported futures independently of optional candle contracts'
assert 'new XElement' in method('ProcessExecution') and 'if (!accepting)' not in method('ProcessExecution'),'Queued fills must drain after capture is stopped'
assert 'Fill time needs review' in method('ProcessExecution') and 'catch (Exception error)' in method('ProcessExecution'),'An uncertain fill time must be reported without stopping the file writer'
calls=[]
for n in descendants(tree.root_node):
    if n.type=='invocation_expression':
        target=n.child_by_field_name('function')
        if target is not None:
            calls.append(code(target))
assert not any(c.rsplit('.',1)[-1] in ['Submit','CreateOrder','Cancel','CancelAllOrders','Flatten'] for c in calls),'Order action found in passive recorder'
assert all(c in ['timer.Change','reconcile.Change'] for c in calls if c.endswith('.Change')),'Unexpected change command'
assert not any(word in source.decode() for word in ['System.Net','HttpClient','WebClient','ClientWebSocket']),'Network code found'
assert 'candidates.Where(Connected)' in method('SynchronizeAccounts')
assert 'RecoverAccount(closing, true)' in method('SynchronizeAccounts')
assert 'RecoverAccount(account, true)' in method('StopAndSave')
assert 'Account.AccountStatusUpdate -= OnAccountStatus' in method('StopAndSave')
assert 'SaveDays(true)' in method('WriteLoop') and 'if (exportCsv) SaveCsv()' in method('Save')
assert 'if (recordPrices)' in method('Start') and 'now.Date.AddDays(-historyDays)' in method('RequestPrices')
assert 'new XAttribute("schemaVersion", "1")' in source.decode(),'Capture format must remain compatible'
print(json.dumps({'csharpSyntax':'passed','passiveApi':'passed','callbackBoundaries':'passed','stopDrain':'passed','legacyFormat':'schema 1','nativeNinjaTraderCompile':'not available in this environment'}))
