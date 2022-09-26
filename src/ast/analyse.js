import Scope from './Scope';
import getLocation from '../utils/getLocation';
import { getName } from '../utils/map-helpers';
import { has } from '../utils/object';
import walk from './walk';

export default function analyse(ast, magicString, module) {
	// 创建一个作用域对象
	let scope = new Scope();
	let currentTopLevelStatement;

	function addToScope(declarator) {
		var name = declarator.id.name;
		scope.add(name, false);

		if (!scope.parent) {
			currentTopLevelStatement._defines[name] = true;
		}
	}

	function addToBlockScope(declarator) {
		var name = declarator.id.name;
		scope.add(name, true);

		if (!scope.parent) {
			currentTopLevelStatement._defines[name] = true;
		}
	}

	// 给每个节点添加上作用域信息
	let previousStatement = null;
	let commentIndex = 0;

	ast.body.forEach(statement => {
		currentTopLevelStatement = statement; // so we can attach scoping info

		Object.defineProperties(statement, {
			_defines: { value: {} },
			_modifies: { value: {} },
			_dependsOn: { value: {} },
			_included: { value: false, writable: true },
			_module: { value: module },
			_source: { value: magicString.snip(statement.start, statement.end) }, // TODO don't use snip, it's a waste of memory
			_margin: { value: [0, 0] },
			_leadingComments: { value: [] },
			_trailingComment: { value: null, writable: true },
		});

		let trailing = !!previousStatement;

		// attach leading comment
		do {
			const comment = module.comments[commentIndex];

			if (!comment || (comment.end > statement.start)) break;

			// attach any trailing comment to the previous statement
			if (trailing && !/\n/.test(magicString.slice(previousStatement.end, comment.start))) {
				previousStatement._trailingComment = comment;
			}

			// then attach leading comments to this statement
			else {
				statement._leadingComments.push(comment);
			}

			commentIndex += 1;
			trailing = false;
		} while (module.comments[commentIndex]);

		// determine margin
		const previousEnd = previousStatement ? (previousStatement._trailingComment || previousStatement).end : 0;
		const start = (statement._leadingComments[0] || statement).start;

		const gap = magicString.original.slice(previousEnd, start);
		const margin = gap.split('\n').length;

		if (previousStatement) previousStatement._margin[1] = margin;
		statement._margin[0] = margin;

		// 递归遍历一次所有的属性
		walk(statement, {
			enter(node) {
				let newScope;

				magicString.addSourcemapLocation(node.start);

				switch (node.type) {
					// 函数的处理方式
					case 'FunctionExpression':
					case 'FunctionDeclaration':
					case 'ArrowFunctionExpression':
						let names = node.params.map(getName);

						if (node.type === 'FunctionDeclaration') {
							addToScope(node);
						} else if (node.type === 'FunctionExpression' && node.id) {
							names.push(node.id.name);
						}

						newScope = new Scope({
							parent: scope,
							params: names, // TODO rest params?
							block: false
						});

						break;

					case 'BlockStatement':
						newScope = new Scope({
							parent: scope,
							block: true
						});

						break;

					case 'CatchClause':
						newScope = new Scope({
							parent: scope,
							params: [node.param.name],
							block: true
						});

						break;

					case 'VariableDeclaration':
						node.declarations.forEach(node.kind === 'let' ? addToBlockScope : addToScope); // TODO const?
						break;

					case 'ClassDeclaration':
						addToScope(node);
						break;
				}

				if (newScope) {
					Object.defineProperty(node, '_scope', { value: newScope });
					scope = newScope;
				}
			},
			leave(node) {
				if (node === currentTopLevelStatement) {
					currentTopLevelStatement = null;
				}

				if (node._scope) {
					scope = scope.parent;
				}
			}
		});

		previousStatement = statement;
	});

	// 然后，我们需要找到此语句具有哪些顶层依赖项，以及它可能修改哪些
	ast.body.forEach(statement => {
		function checkForReads(node, parent) {
			if (node.type === 'Identifier') {
				// disregard the `bar` in `foo.bar` - these appear as Identifier nodes
				if (parent.type === 'MemberExpression' && node !== parent.object) {
					return;
				}

				// disregard the `bar` in { bar: foo }
				if (parent.type === 'Property' && node !== parent.value) {
					return;
				}

				const definingScope = scope.findDefiningScope(node.name);

				// 如果没有作用域 || 作用域深度为0 同时 当前的语句定义的变量中没有对应的name值，说明这个值是从外部读取的。所以设置为true
				if ((!definingScope || definingScope.depth === 0) && !statement._defines[node.name]) {
					statement._dependsOn[node.name] = true;
				}
			}

		}

		function checkForWrites(node) {
			function addNode(node, disallowImportReassignments) {
				while (node.type === 'MemberExpression') {
					node = node.object;
				}

				// disallow assignments/updates to imported bindings and namespaces
				if (disallowImportReassignments && has(module.imports, node.name) && !scope.contains(node.name)) {
					const err = new Error(`Illegal reassignment to import '${node.name}'`);
					err.file = module.path;
					err.loc = getLocation(module.code.toString(), node.start);
					throw err;
				}

				if (node.type !== 'Identifier') {
					return;
				}

				// 这个要改的属性值编辑设置为true
				statement._modifies[node.name] = true;
			}

			if (node.type === 'AssignmentExpression') {
				addNode(node.left, true);
			}

			else if (node.type === 'UpdateExpression') {
				addNode(node.argument, true);
			}

			else if (node.type === 'CallExpression') {
				node.arguments.forEach(arg => addNode(arg, false));
			}

			// TODO UpdateExpressions, method calls?
		}

		walk(statement, {
			enter(node, parent) {
				// skip imports
				if (/^Import/.test(node.type)) return this.skip();

				if (node._scope) scope = node._scope;

				checkForReads(node, parent);
				checkForWrites(node, parent);

				//if ( node.type === 'ReturnStatement')

			},
			leave(node) {
				if (node._scope) scope = scope.parent;
			}
		});
	});

	ast._scope = scope;
}
