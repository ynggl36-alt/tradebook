"""Parse the temporary diagnostic and enforce its passive permission boundary.

Uses validation-only tree-sitter dependencies, like check-recorder.py.
Does not replace compilation against NinjaTrader's Windows assemblies.
"""
import json, sys
from pathlib import Path
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / '.sites-runtime/validation-python'))
from tree_sitter import Language, Parser
import tree_sitter_c_sharp

def validate(source):
    tree = Parser(Language(tree_sitter_c_sharp.language())).parse(source)
    def nodes(node):
        yield node
        for child in node.children:
            yield from nodes(child)
    found = list(nodes(tree.root_node))
    assert not [(n.type, n.start_point) for n in found if n.type == 'ERROR' or n.is_missing], 'C# syntax error'
    def code(node):
        return source[node.start_byte:node.end_byte].decode()
    calls = [code(n.child_by_field_name('function')).rsplit('.', 1)[-1] for n in found if n.type == 'invocation_expression']
    forbidden = {'CreateOrder', 'Submit', 'SubmitOrderUnmanaged', 'EnterLong', 'EnterShort', 'ExitLong', 'ExitShort', 'Cancel', 'CancelAllOrders', 'CancelOrder', 'Change', 'ChangeOrder', 'Flatten', 'SetValue', 'Invoke', 'InvokeMember', 'SetState', 'StartAtmStrategy'}
    assert not set(calls) & forbidden, 'Trading/state/reflection write action found'
    text = source.decode()
    assert not any(name in text for name in ['System.Net', 'HttpClient', 'WebClient', 'WebSocket', 'System.IO', 'StreamReader', 'StreamWriter', 'BindingFlags.NonPublic', 'Task.Run', 'Thread.Sleep', 'new Timer', 'BarsRequest']), 'Unexpected network, storage, private access or polling'
    for node in found:
        if node.type == 'assignment_expression':
            left = code(node.child_by_field_name('left'))
            if left.startswith(('account.', 'order.', 'e.Account.', 'e.Order.')):
                assert code(node).strip() in ['account.OrderUpdate += OnNativeOrder', 'account.OrderUpdate -= OnNativeOrder'], 'Native account/order mutation found'
    return True

source = (root / 'diagnostics/TradebookAccountDiagnostic.cs').read_bytes()
assert validate(source)
# Negative controls ensure the permission guard actually rejects regressions.
for forbidden in [b'account.Submit(null);', b'account.Flatten(null);', b'property.SetValue(account, true);']:
    bad = source.replace(b'protected override void OnBarUpdate() { }', b'protected override void OnBarUpdate() { ' + forbidden + b' }')
    try:
        validate(bad)
    except AssertionError:
        pass
    else:
        raise AssertionError('Permission guard missed a forbidden action')
print(json.dumps({'csharpSyntax': 'passed', 'passiveBoundary': 'passed', 'negativeControls': 3, 'nativeNinjaTraderCompile': 'not available'}))
