/**
 * MOST Web Framework 2.0 Codename Blueshift
 * Copyright (c) 2017, THEMOST LP All rights reserved
 *
 * Use of this source code is governed by an BSD-3-Clause license that can be
 * found in the LICENSE file at https://themost.io/license
 */
import * as initSqlJs from 'sql.js';
import {SqlUtils, QueryExpression} from '@themost/query';
import {MemoryFormatter} from './MemoryFormatter';
import {TraceUtils} from '@themost/common';
import {eachSeries, waterfall} from 'async';
/**
 *
 */
export class MemoryAdapter {

    constructor(options) {
        /**
         * @type {{database: string}}
         */
        this.options = options || { database: ':memory:' };
        /**
         * Represents the database raw connection associated with this adapter
         * @type {*}
         */
        this.rawConnection = null;
    }

    open(callback) {
        const self = this;
        callback = callback || function() {};
        if (self.rawConnection) {
            return callback();
        }
        return initSqlJs.then( SQL => {
            self.rawConnection = new SQL.Database();
            return callback();
        }).catch( err => {
            return callback(err);
        });
    }

    close(callback) {
        const self = this;
        callback = callback || function() {};
        if (self.rawConnection == null) {
            return callback();
        }
        self.rawConnection = null;
        return callback();
    }

    /**
     * @param {string} query
     * @param {*=} values
     */
    prepare(query, values) {
        return SqlUtils.format(query,values);
    }

    static formatType(field) {
        const size = parseInt(field.size);
        let s;
        switch (field.type)
        {
            case 'Boolean':
                s = 'INTEGER(1,0)';
                break;
            case 'Byte':
                s = 'INTEGER(1,0)';
                break;
            case 'Number':
            case 'Float':
                s = 'REAL';
                break;
            case 'Counter':
                return 'INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL';
            case 'Currency':
                s =  'NUMERIC(' + (field.size || 19) + ',4)';
                break;
            case 'Decimal':
                s =  'NUMERIC';
                if ((field.size) && (field.scale)) { s += '(' + field.size + ',' + field.scale + ')'; }
                break;
            case 'Date':
            case 'DateTime':
                s = 'NUMERIC';
                break;
            case 'Time':
                s = size>0 ?  `TEXT(${size},0)` : 'TEXT';
                break;
            case 'Long':
                s = 'NUMERIC';
                break;
            case 'Duration':
                s = size > 0 ? `TEXT(${size},0)` : 'TEXT(48,0)';
                break;
            case 'Integer':
                s = 'INTEGER' + (size ? '(' + size + ',0)':'' );
                break;
            case 'URL':
            case 'Text':
            case 'Note':
                s = size > 0 ? `TEXT(${size},0)` : 'TEXT';
                break;
            case 'Image':
            case 'Binary':
                s ='BLOB';
                break;
            case 'Guid':
                s = 'TEXT(36,0)';
                break;
            case 'Short':
                s = 'INTEGER(2,0)';
                break;
            default:
                s = 'INTEGER';
                break;
        }
        if (field.primary) {
            return s.concat(' PRIMARY KEY NOT NULL');
        }
        else {
            return s.concat((field.nullable===undefined) ? ' NULL': (field.nullable ? ' NULL': ' NOT NULL'));
        }
    }

    /**
     * Begins a transactional operation by executing the given function
     * @param fn {function} The function to execute
     * @param callback {function(Error=)} The callback that contains the error -if any- and the results of the given operation
     */
    executeInTransaction(fn, callback) {
        const self = this;
        //ensure parameters
        fn = fn || function() {}; callback = callback || function() {};
        self.open(function(err) {
            if (err) {
                callback(err);
            }
            else {
                if (self.transaction) {
                    fn.call(self, function(err) {
                        callback(err);
                    });
                }
                else {
                    //begin transaction
                    self.rawConnection.run('BEGIN TRANSACTION;', undefined, function(err) {
                        if (err) {
                            callback(err);
                            return;
                        }
                        //initialize dummy transaction object (for future use)
                        self.transaction = { };
                        //execute function
                        fn.call(self, function(err) {
                            if (err) {
                                //rollback transaction
                                self.rawConnection.run('ROLLBACK;', undefined, function() {
                                    self.transaction = null;
                                    callback(err);
                                });
                            }
                            else {
                                //commit transaction
                                self.rawConnection.run('COMMIT;', undefined, function(err) {
                                    self.transaction = null;
                                    callback(err);
                                });
                            }
                        });
                    });
                }
            }
        });
    }

    /**
     *
     * @param {string} name
     * @param {QueryExpression|*} query
     * @param {function(Error=)} callback
     */
    createView(name, query, callback) {
        this.view(name).create(query, callback);
    }

    /*
     * @param {DataModelMigration|*} obj An Object that represents the data model scheme we want to migrate
     * @param {function(Error=)} callback
     */
    migrate(obj, callback) {
        const self = this;
        callback = callback || function() {};
        if (obj == null) {
            return callback();
        }
        /**
         * @type {*}
         */
        const migration = obj;
        const format = function(format, obj)
        {
            let result = format;
            if (/%t/.test(format))
                result = result.replace(/%t/g,MemoryAdapter.formatType(obj));
            if (/%f/.test(format))
                result = result.replace(/%f/g,obj.name);
            return result;
        };


        waterfall([
            //1. Check migrations table existence
            function(cb) {
                if (SqliteAdapter.supportMigrations) {
                    cb(null, true);
                    return;
                }
                self.table('migrations').exists(function(err, exists) {
                    if (err) { cb(err); return; }
                    cb(null, exists);
                });
            },
            //2. Create migrations table, if it does not exist
            function(arg, cb) {
                if (arg) { cb(null, 0); return; }
                //create migrations table
                self.execute('CREATE TABLE migrations("id" INTEGER PRIMARY KEY AUTOINCREMENT, ' +
                    '"appliesTo" TEXT NOT NULL, "model" TEXT NULL, "description" TEXT,"version" TEXT NOT NULL)',
                    [], function(err) {
                        if (err) { cb(err); return; }
                        SqliteAdapter.supportMigrations=true;
                        cb(null, 0);
                    });
            },
            //3. Check if migration has already been applied (true=Table version is equal to migration version, false=Table version is older from migration version)
            function(arg, cb) {
                self.table(migration.appliesTo).version(function(err, version) {
                    if (err) { cb(err); return; }
                    cb(null, (version>=migration.version));
                });
            },
            //4a. Check table existence (-1=Migration has already been applied, 0=Table does not exist, 1=Table exists)
            function(arg, cb) {
                //migration has already been applied (set migration.updated=true)
                if (arg) {
                    migration.updated=true;
                    cb(null, -1);
                }
                else {
                    self.table(migration.appliesTo).exists(function(err, exists) {
                        if (err) { cb(err); return; }
                        cb(null, exists ? 1 : 0);
                    });

                }
            },
            //4. Get table columns
            function(arg, cb) {
                //migration has already been applied
                if (arg<0) { cb(null, [arg, null]); return; }
                self.table(migration.appliesTo).columns(function(err, columns) {
                    if (err) { cb(err); return; }
                    cb(null, [arg, columns]);
                });
            },
            //5. Migrate target table (create or alter)
            function(args, cb) {
                //migration has already been applied (args[0]=-1)
                if (args[0] < 0) {
                    cb(null, args[0]);
                }
                else if (args[0] === 0) {
                    //create table
                    const strFields = migration.add.filter(function(x) {
                        return !x['oneToMany'];
                    }).map(
                        function(x) {
                            return format('"%f" %t', x);
                        }).join(', ');
                    const sql = `CREATE TABLE "${migration.appliesTo}" (${strFields})`;
                    self.execute(sql, null, function(err) {
                        if (err) { cb(err); return; }
                        cb(null, 1);
                    });
                }
                else if (args[0] === 1) {
                    const expressions = [];

                    const /**
                     * @type {{columnName:string,ordinal:number,dataType:*, maxLength:number,isNullable:number,,primary:boolean }[]}
                     */
                    columns = args[1];

                    let forceAlter = false;
                    let column;
                    let newType;
                    let oldType;
                    //validate operations

                    //1. columns to be removed
                    if (Array.isArray(migration.remove)) {
                        if (migration.remove>0) {
                            for (let i = 0; i < migration.remove.length; i++) {
                                let x = migration.remove[i];
                                let colIndex = columns.findIndex( y => {
                                    return y.name === x.name;
                                });
                                if (colIndex>=0) {
                                    if (!columns[colIndex].primary) {
                                        forceAlter = true;
                                    }
                                    else {
                                        migration.remove.splice(i, 1);
                                        i-=1;
                                    }
                                }
                                else {
                                    migration.remove.splice(i, 1);
                                    i-=1;
                                }
                            }
                        }
                    }
                    //1. columns to be changed
                    if (Array.isArray(migration.change)) {
                        if (migration.change>0) {

                            for (let i = 0; i < migration.change.length; i++) {
                                let x = migration.change[i];
                                column = columns.find( y => {
                                    return y.name === x.name;
                                });
                                if (column) {
                                    if (!column.primary) {
                                        //validate new column type (e.g. TEXT(120,0) NOT NULL)
                                        newType = format('%t', x); oldType = column.type.toUpperCase().concat(column.nullable ? ' NOT NULL' : ' NULL');
                                        if ((newType !== oldType)) {
                                            //force alter
                                            forceAlter = true;
                                        }
                                    }
                                    else {
                                        //remove column from change collection (because it's a primary key)
                                        migration.change.splice(i, 1);
                                        i-=1;
                                    }
                                }
                                else {
                                    //add column (column was not found in table)
                                    migration.add.push(x);
                                    //remove column from change collection
                                    migration.change.splice(i, 1);
                                    i-=1;
                                }

                            }

                        }
                    }
                    if (Array.isArray(migration.add)) {

                        for (let i = 0; i < migration.add.length; i++) {
                            let x = migration.add[i];
                            column = columns.find( y => {
                                return (y.name === x.name);
                            });
                            if (column) {
                                if (column.primary) {
                                    migration.add.splice(i, 1);
                                    i-=1;
                                }
                                else {
                                    newType = format('%t', x); oldType = column.type.toUpperCase().concat(column.nullable ? ' NOT NULL' : ' NULL');
                                    if (newType === oldType) {
                                        //remove column from add collection
                                        migration.add.splice(i, 1);
                                        i-=1;
                                    }
                                    else {
                                        forceAlter = true;
                                    }
                                }
                            }
                        }
                        if (forceAlter) {
                            cb(new Error('Full table migration is not yet implemented.'));
                            return;
                        }
                        else {
                            migration.add.forEach(function(x) {
                                //search for columns
                                expressions.push(`ALTER TABLE "${migration.appliesTo}" ADD COLUMN "${x.name}" ${MemoryAdapter.formatType(x)}`);
                            });
                        }

                    }
                    if (expressions.length>0) {
                        eachSeries(expressions, function(expr,cb) {
                            self.execute(expr, [], function(err) {
                                cb(err);
                            });
                        }, function(err) {
                            if (err) { cb(err); return; }
                            cb(null, 1);
                        });
                    }
                    else {
                        cb(null, 2);
                    }
                }
                else {
                    cb(new Error('Invalid table status.'));
                }
            },
            //Apply data model indexes
            function (arg, cb) {
                if (arg<=0) { return cb(null, arg); }
                if (migration.indexes) {
                    const tableIndexes = self.indexes(migration.appliesTo);
                    //enumerate migration constraints
                    eachSeries(migration.indexes, function(index, indexCallback) {
                        tableIndexes.create(index.name, index.columns, indexCallback);
                    }, function(err) {
                        //throw error
                        if (err) { return cb(err); }
                        //or return success flag
                        return cb(null, 1);
                    });
                }
                else {
                    //do nothing and exit
                    return cb(null, 1);
                }
            },
            function(arg, cb) {
                if (arg>0) {
                    //log migration to database
                    self.execute('INSERT INTO migrations("appliesTo", "model", "version", "description") VALUES (?,?,?,?)', [migration.appliesTo,
                        migration.model,
                        migration.version,
                        migration.description ], function(err) {
                        if (err)  {
                            return cb(err);
                        }
                        cb(null, 1);
                    });
                }
                else {
                    migration.updated = true;
                    cb(null, arg);
                }
            }
        ], function(err) {
            callback(err);
        });

    }

    /**
     * Produces a new identity value for the given entity and attribute.
     * @param entity {String} The target entity name
     * @param attribute {String} The target attribute
     * @param callback {Function=}
     */
    selectIdentity(entity, attribute, callback) {

        const self = this;

        const migration = {
            appliesTo:'increment_id',
            model:'increments',
            description:'Increments migration (version 1.0)',
            version:'1.0',
            add:[
                { name:'id', type:'Counter', primary:true },
                { name:'entity', type:'Text', size:120 },
                { name:'attribute', type:'Text', size:120 },
                { name:'value', type:'Integer' }
            ]
        };
        //ensure increments entity
        self.migrate(migration, function(err)
        {
            //throw error if any
            if (err) { callback.call(self,err); return; }
            self.execute('SELECT * FROM increment_id WHERE entity=? AND attribute=?', [entity, attribute], function(err, result) {
                if (err) { callback.call(self,err); return; }
                if (result.length===0) {
                    //get max value by querying the given entity
                    const q = new QueryExpression().from(entity).select([new QueryField().max(attribute)]);
                    self.execute(q,null, function(err, result) {
                        if (err) { callback.call(self, err); return; }
                        let value = 1;
                        if (result.length>0) {
                            value = (parseInt(result[0][attribute]) || 0)+ 1;
                        }
                        self.execute('INSERT INTO increment_id(entity, attribute, value) VALUES (?,?,?)',[entity, attribute, value], function(err) {
                            //throw error if any
                            if (err) { callback.call(self, err); return; }
                            //return new increment value
                            callback.call(self, err, value);
                        });
                    });
                }
                else {
                    //get new increment value
                    const value = parseInt(result[0].value) + 1;
                    self.execute('UPDATE increment_id SET value=? WHERE id=?',[value, result[0].id], function(err) {
                        //throw error if any
                        if (err) { callback.call(self, err); return; }
                        //return new increment value
                        callback.call(self, err, value);
                    });
                }
            });
        });
    }

    table(name) {
        const self = this;
        return {
            /**
             * @param {function(Error,Boolean=)} callback
             */
            exists:function(callback) {
                self.execute('SELECT COUNT(*) count FROM sqlite_master WHERE name=? AND type=\'table\';', [name], function(err, result) {
                    if (err) { callback(err); return; }
                    callback(null, (result[0].count>0));
                });
            },
            /**
             * @param {function(Error,string=)} callback
             */
            version:function(callback) {
                self.execute('SELECT MAX(version) AS version FROM migrations WHERE appliesTo=?',
                    [name], function(err, result) {
                        if (err) { return callback(err); }
                        if (result.length === 0)
                            callback(null, '0.0');
                        else
                            callback(null, result[0].version || '0.0');
                    });
            },
            /**
             * @param {function(Error,Boolean=)} callback
             */
            has_sequence:function(callback) {
                callback = callback || function() {};
                self.execute('SELECT COUNT(*) count FROM sqlite_sequence WHERE name=?',
                    [name], function(err, result) {
                        if (err) { callback(err); return; }
                        callback(null, (result[0].count>0));
                    });
            },
            /**
             * @param {function(Error=,Array=)} callback
             */
            columns:function(callback) {
                callback = callback || function() {};
                self.execute('PRAGMA table_info(?)',
                    [name], function(err, result) {
                        if (err) { callback(err); return; }
                        const arr = [];
                        /**
                         * enumerates table columns
                         * @param {{name:string},{cid:number},{type:string},{notnull:number},{pk:number}} x
                         */
                        const iterator = function(x) {
                            const col = {
                                name: x.name,
                                ordinal: x.cid,
                                type: x.type,
                                nullable: (!!x.notnull),
                                primary: (x.pk === 1)
                            };
                            const matches = /(\w+)\((\d+),(\d+)\)/.exec(x.type);
                            if (matches) {
                                //extract max length attribute (e.g. integer(2,0) etc)
                                if (parseInt(matches[2])>0) { col.size =  parseInt(matches[2]); }
                                //extract scale attribute from field (e.g. integer(2,0) etc)
                                if (parseInt(matches[3])>0) { col.scale =  parseInt(matches[3]); }
                            }
                            arr.push(col);
                        };
                        result.forEach(iterator);
                        callback(null, arr);
                    });
            }
        };

    }

    view(name) {
        const self = this;
        const formatter = new MemoryFormatter();
        return {
            /**
             * @param {function(Error,Boolean=)} callback
             */
            exists:function(callback) {
                self.execute(`SELECT COUNT(*) count FROM sqlite_master WHERE name=? AND type=\'view\';`, [name], function(err, result) {
                    if (err) { callback(err); return; }
                    callback(null, (result[0].count>0));
                });
            },
            /**
             * @param {function(Error=)} callback
             */
            drop:function(callback) {
                callback = callback || function() {};
                self.open(function(err) {
                    if (err) { callback(err); return; }
                    const sql = `DROP VIEW IF EXISTS ${formatter.escapeName(name)}`;
                    self.execute(sql, undefined, function(err) {
                        if (err) { callback(err); return; }
                        callback();
                    });
                });
            },
            /**
             * @param {QueryExpression|*} q
             * @param {function(Error=)} callback
             */
            create:function(q, callback) {
                const thisArg = this;
                self.executeInTransaction(function(tr) {
                    thisArg.drop(function(err) {
                        if (err) { tr(err); return; }
                        try {
                            let sql = `CREATE VIEW ${formatter.escapeName(name)} AS `;
                            const formatter = new MemoryFormatter();
                            sql += formatter.format(q);
                            self.execute(sql, undefined, tr);
                        }
                        catch(e) {
                            tr(e);
                        }
                    });
                }, function(err) {
                    callback(err);
                });

            }
        };
    }

    /**
     * Executes a query against the underlying database
     * @param query {QueryExpression|string|*}
     * @param values {*=}
     * @param {function(Error=,*=)} callback
     */
    execute(query, values, callback) {
        const self = this;
        let sql = null;
        try {

            if (typeof query === 'string') {
                //get raw sql statement
                sql = query;
            }
            else {
                //format query expression or any object that may be act as query expression
                const formatter = new MemoryFormatter();
                sql = formatter.format(query);
            }
            //validate sql statement
            if (sql == null) {
                return callback.call(self, new Error('The executing command is of the wrong type or empty.'));
            }
            //ensure connection
            self.open(function(err) {
                if (err) {
                    callback.call(self, err);
                }
                else {
                    //log statement (optional)
                    if (process.env.NODE_ENV==='development')
                        TraceUtils.log(`SQL:${sql}, Parameters:${JSON.stringify(values)}`);

                    //prepare statement - the traditional way
                    const prepared = self.prepare(sql, values);

                    let fn;
                    //validate statement
                    if (/^(SELECT|PRAGMA)/ig.test(prepared)) {
                        //prepare for select
                        fn = self.rawConnection.all;
                    }
                    else {
                        //otherwise prepare for run
                        fn = self.rawConnection.run;
                    }
                    //execute raw command
                    fn.call(self.rawConnection, prepared, [] , function(err, result) {
                        if (err) {
                            //log sql
                            TraceUtils.error(`SQL Error:${prepared}`);
                            callback(err);
                        }
                        else {
                            if (result) {
                                if (typeof result === 'object') {
                                    let keys;
                                    if (Array.isArray(result)) {
                                        if (result.length>0) {
                                            keys = Object.keys(result[0]);
                                            result.forEach(function(x) {
                                                keys.forEach(function(y) {
                                                    if (x[y] === null) { delete x[y]; }
                                                });
                                            });
                                        }
                                    }
                                    else {
                                        keys = Object.keys(result);
                                        keys.forEach(function(y) {
                                            if (result[y] === null) { delete result[y]; }
                                        });
                                    }
                                }
                                return callback(null, result);
                            }
                            else {
                                return callback();
                            }

                        }
                    });
                }
            });
        }
        catch (e) {
            callback.call(self, e);
        }
    }

    lastIdentity(callback) {
        const self = this;
        self.open(function(err) {
            if (err) {
                callback(err);
            }
            else {
                //execute lastval (for sequence)
                self.execute('SELECT last_insert_rowid() as lastval', [], function(err, lastval) {
                    if (err) {
                        callback(null, { insertId: null });
                    }
                    else {
                        lastval = lastval || [];
                        if (lastval.length>0)
                            callback(null, { insertId:lastval[0].lastval });
                        else
                            callback(null, { insertId: null });
                    }
                });
            }
        });
    }

    indexes(table) {
        const self = this;
        const formatter = new MemoryFormatter();
        return {
            list: function (callback) {
                const this1 = this;
                if (this1.hasOwnProperty('indexes_')) {
                    return callback(null, this1['indexes_']);
                }
                self.execute(`PRAGMA INDEX_LIST(${formatter.escapeName(table)})`, null , function (err, result) {
                    if (err) { return callback(err); }
                    const indexes = result.filter(function(x) {
                        return x.origin === 'c';
                    }).map(function(x) {
                        return {
                            name:x.name,
                            columns:[]
                        };
                    });
                    eachSeries(indexes, function(index, cb) {
                        self.execute(`PRAGMA INDEX_INFO(${formatter.escapeName(index.name)})`, null, function(err, columns) {
                            if (err) { return cb(err); }
                            index.columns = columns.map( x => {
                                return x.name;
                            });
                            return cb();
                        });
                    }, function(err) {
                        if (err) {
                            return callback(err);
                        }
                        this1['indexes_'] = indexes;
                        return callback(null, indexes);
                    });
                });
            },
            /**
             * @param {string} name
             * @param {Array|string} columns
             * @param {Function} callback
             */
            create: function(name, columns, callback) {
                const cols = [];
                if (typeof columns === 'string') {
                    cols.push(columns);
                }
                else if (Array.isArray(columns)) {
                    cols.push.apply(cols, columns);
                }
                else {
                    return callback(new Error("Invalid parameter. Columns parameter must be a string or an array of strings."));
                }

                const thisArg = this;
                thisArg.list(function(err, indexes) {
                    if (err) { return callback(err); }
                    const ix = indexes.find(function(x) { return x.name === name; });
                    //format create index SQL statement
                    const tableName = formatter.escapeName(table);
                    const indexName = formatter.escapeName(name);
                    const indexColumns = cols.map( x => {
                        return formatter.escapeName(x);
                    }).join(",");
                    const sqlCreateIndex = `CREATE INDEX ${indexName} ON ${tableName}(${indexColumns})`;
                    if ( ix == null) {
                        self.execute(sqlCreateIndex, [], callback);
                    }
                    else {
                        let nCols = cols.length;
                        //enumerate existing columns
                        ix.columns.forEach(function(x) {
                            if (cols.indexOf(x)>=0) {
                                //column exists in index
                                nCols -= 1;
                            }
                        });
                        if (nCols>0) {
                            //drop index
                            thisArg.drop(name, function(err) {
                                if (err) { return callback(err); }
                                //and create it
                                self.execute(sqlCreateIndex, [], callback);
                            });
                        }
                        else {
                            //do nothing
                            return callback();
                        }
                    }
                });


            },
            drop: function(name, callback) {
                if (typeof name !== 'string') {
                    return callback(new Error("Name must be a valid string."));
                }
                self.execute(`PRAGMA INDEX_LIST(${self.escapeName(table)})`, null, function(err, result) {
                    if (err) { return callback(err); }
                    const exists = typeof result.find(function(x) { return x.name===name; }) !== 'undefined';
                    if (!exists) {
                        return callback();
                    }
                    self.execute(`DROP INDEX ${self.escapeName(name)}`, [], callback);
                });
            }
        };
    }

}
