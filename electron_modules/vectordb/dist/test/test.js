"use strict";
// Copyright 2023 LanceDB Developers.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
Object.defineProperty(exports, "__esModule", { value: true });
const mocha_1 = require("mocha");
const temp_1 = require("temp");
const chai = require("chai");
const chaiAsPromised = require("chai-as-promised");
const lancedb = require("../index");
const index_1 = require("../index");
const apache_arrow_1 = require("apache-arrow");
const expect = chai.expect;
const assert = chai.assert;
chai.use(chaiAsPromised);
(0, mocha_1.describe)('LanceDB client', function () {
    (0, mocha_1.describe)('when creating a connection to lancedb', function () {
        it('should have a valid url', async function () {
            const uri = await createTestDB();
            const con = await lancedb.connect(uri);
            assert.equal(con.uri, uri);
        });
        it('should accept an options object', async function () {
            const uri = await createTestDB();
            const con = await lancedb.connect({ uri });
            assert.equal(con.uri, uri);
        });
        it('should accept custom aws credentials', async function () {
            const uri = await createTestDB();
            const awsCredentials = {
                accessKeyId: '',
                secretKey: ''
            };
            const con = await lancedb.connect({
                uri,
                awsCredentials
            });
            assert.equal(con.uri, uri);
        });
        it('should accept custom storage options', async function () {
            const uri = await createTestDB();
            const storageOptions = {
                region: 'us-west-2',
                timeout: '30s'
            };
            const con = await lancedb.connect({
                uri,
                storageOptions
            });
            assert.equal(con.uri, uri);
        });
        it('should return the existing table names', async function () {
            const uri = await createTestDB();
            const con = await lancedb.connect(uri);
            assert.deepEqual(await con.tableNames(), ['vectors']);
        });
    });
    (0, mocha_1.describe)('when querying an existing dataset', function () {
        it('should open a table', async function () {
            const uri = await createTestDB();
            const con = await lancedb.connect(uri);
            const table = await con.openTable('vectors');
            assert.equal(table.name, 'vectors');
        });
        it('execute a query', async function () {
            const uri = await createTestDB();
            const con = await lancedb.connect(uri);
            const table = await con.openTable('vectors');
            const results = await table.search([0.1, 0.3]).execute();
            assert.equal(results.length, 2);
            assert.equal(results[0].price, 10);
            const vector = results[0].vector;
            assert.approximately(vector[0], 0.0, 0.2);
            assert.approximately(vector[0], 0.1, 0.3);
        });
        it('limits # of results', async function () {
            const uri = await createTestDB(2, 100);
            const con = await lancedb.connect(uri);
            const table = await con.openTable('vectors');
            let results = await table.search([0.1, 0.3]).limit(1).execute();
            assert.equal(results.length, 1);
            assert.equal(results[0].id, 1);
            // there is a default limit if unspecified
            results = await table.search([0.1, 0.3]).execute();
            assert.equal(results.length, 10);
        });
        it('uses a filter / where clause without vector search', async function () {
            // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
            const assertResults = (results) => {
                assert.equal(results.length, 50);
            };
            const uri = await createTestDB(2, 100);
            const con = await lancedb.connect(uri);
            const table = (await con.openTable('vectors'));
            let results = await table.filter('id % 2 = 0').limit(100).execute();
            assertResults(results);
            results = await table.where('id % 2 = 0').limit(100).execute();
            assertResults(results);
            // Should reject a bad filter
            await expect(table.filter('id % 2 = 0 AND').execute()).to.be.rejectedWith(/.*sql parser error: Expected an expression:, found: EOF.*/);
        });
        it('uses a filter / where clause', async function () {
            // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
            const assertResults = (results) => {
                assert.equal(results.length, 1);
                assert.equal(results[0].id, 2);
            };
            const uri = await createTestDB();
            const con = await lancedb.connect(uri);
            const table = await con.openTable('vectors');
            let results = await table.search([0.1, 0.1]).filter('id == 2').execute();
            assertResults(results);
            results = await table.search([0.1, 0.1]).where('id == 2').execute();
            assertResults(results);
        });
        it('should correctly process prefilter/postfilter', async function () {
            const uri = await createTestDB(16, 300);
            const con = await lancedb.connect(uri);
            const table = await con.openTable('vectors');
            await table.createIndex({
                type: 'ivf_pq',
                column: 'vector',
                num_partitions: 2,
                max_iters: 2,
                num_sub_vectors: 2
            });
            // post filter should return less than the limit
            let results = await table
                .search(new Array(16).fill(0.1))
                .limit(10)
                .filter('id >= 10')
                .prefilter(false)
                .execute();
            assert.isTrue(results.length < 10);
            // pre filter should return exactly the limit
            results = await table
                .search(new Array(16).fill(0.1))
                .limit(10)
                .filter('id >= 10')
                .prefilter(true)
                .execute();
            assert.isTrue(results.length === 10);
        });
        it('should allow creation and use of scalar indices', async function () {
            const uri = await createTestDB(16, 300);
            const con = await lancedb.connect(uri);
            const table = await con.openTable('vectors');
            await table.createScalarIndex('id', true);
            // Prefiltering should still work the same
            const results = await table
                .search(new Array(16).fill(0.1))
                .limit(10)
                .filter('id >= 10')
                .prefilter(true)
                .execute();
            assert.isTrue(results.length === 10);
        });
        it('select only a subset of columns', async function () {
            const uri = await createTestDB();
            const con = await lancedb.connect(uri);
            const table = await con.openTable('vectors');
            const results = await table
                .search([0.1, 0.1])
                .select(['is_active', 'vector'])
                .execute();
            assert.equal(results.length, 2);
            // vector and _distance are always returned
            assert.isDefined(results[0].vector);
            assert.isDefined(results[0]._distance);
            assert.isDefined(results[0].is_active);
            assert.isUndefined(results[0].id);
            assert.isUndefined(results[0].name);
            assert.isUndefined(results[0].price);
        });
    });
    (0, mocha_1.describe)('when creating a new dataset', function () {
        it('create an empty table', async function () {
            const dir = await (0, temp_1.track)().mkdir('lancejs');
            const con = await lancedb.connect(dir);
            const schema = new apache_arrow_1.Schema([
                new apache_arrow_1.Field('id', new apache_arrow_1.Int32()),
                new apache_arrow_1.Field('name', new apache_arrow_1.Utf8())
            ]);
            const table = await con.createTable({
                name: 'vectors',
                schema
            });
            assert.equal(table.name, 'vectors');
            assert.deepEqual(await con.tableNames(), ['vectors']);
        });
        it('create a table with a schema and records', async function () {
            const dir = await (0, temp_1.track)().mkdir('lancejs');
            const con = await lancedb.connect(dir);
            const schema = new apache_arrow_1.Schema([
                new apache_arrow_1.Field('id', new apache_arrow_1.Int32()),
                new apache_arrow_1.Field('name', new apache_arrow_1.Utf8()),
                new apache_arrow_1.Field('vector', new apache_arrow_1.FixedSizeList(2, new apache_arrow_1.Field('item', new apache_arrow_1.Float32(), true)), false)
            ]);
            const data = [
                {
                    vector: [0.5, 0.2],
                    name: 'foo',
                    id: 0
                },
                {
                    vector: [0.3, 0.1],
                    name: 'bar',
                    id: 1
                }
            ];
            // even thought the keys in data is out of order it should still work
            const table = await con.createTable({
                name: 'vectors',
                data,
                schema
            });
            assert.equal(table.name, 'vectors');
            assert.deepEqual(await con.tableNames(), ['vectors']);
        });
        it('create a table with a empty data array', async function () {
            const dir = await (0, temp_1.track)().mkdir('lancejs');
            const con = await lancedb.connect(dir);
            const schema = new apache_arrow_1.Schema([
                new apache_arrow_1.Field('id', new apache_arrow_1.Int32()),
                new apache_arrow_1.Field('name', new apache_arrow_1.Utf8())
            ]);
            const table = await con.createTable({
                name: 'vectors',
                schema,
                data: []
            });
            assert.equal(table.name, 'vectors');
            assert.deepEqual(await con.tableNames(), ['vectors']);
        });
        it('create a table from an Arrow Table', async function () {
            const dir = await (0, temp_1.track)().mkdir('lancejs');
            // Also test the connect function with an object
            const con = await lancedb.connect({ uri: dir });
            const i32s = new Int32Array(new Array(10));
            const i32 = (0, apache_arrow_1.makeVector)(i32s);
            const data = new apache_arrow_1.Table({ vector: i32 });
            const table = await con.createTable({
                name: 'vectors',
                data
            });
            assert.equal(table.name, 'vectors');
            assert.equal(await table.countRows(), 10);
            assert.equal(await table.countRows('vector IS NULL'), 0);
            assert.deepEqual(await con.tableNames(), ['vectors']);
        });
        it('creates a new table from javascript objects', async function () {
            const dir = await (0, temp_1.track)().mkdir('lancejs');
            const con = await lancedb.connect(dir);
            const data = [
                { id: 1, vector: [0.1, 0.2], price: 10 },
                {
                    id: 2,
                    vector: [1.1, 1.2],
                    price: 50
                }
            ];
            const tableName = `vectors_${Math.floor(Math.random() * 100)}`;
            const table = await con.createTable(tableName, data);
            assert.equal(table.name, tableName);
            assert.equal(await table.countRows(), 2);
        });
        it('creates a new table from javascript objects with variable sized list', async function () {
            const dir = await (0, temp_1.track)().mkdir('lancejs');
            const con = await lancedb.connect(dir);
            const data = [
                {
                    id: 1,
                    vector: [0.1, 0.2],
                    list_of_str: ['a', 'b', 'c'],
                    list_of_num: [1, 2, 3]
                },
                {
                    id: 2,
                    vector: [1.1, 1.2],
                    list_of_str: ['x', 'y'],
                    list_of_num: [4, 5, 6]
                }
            ];
            const tableName = 'with_variable_sized_list';
            const table = (await con.createTable(tableName, data));
            assert.equal(table.name, tableName);
            assert.equal(await table.countRows(), 2);
            const rs = await table.filter('id>1').execute();
            assert.equal(rs.length, 1);
            assert.deepEqual(rs[0].list_of_str, ['x', 'y']);
            assert.isTrue(rs[0].list_of_num instanceof Array);
        });
        it('create table from arrow table', async () => {
            const dim = 128;
            const total = 256;
            const dir = await (0, temp_1.track)().mkdir('lancejs');
            const con = await lancedb.connect(dir);
            const schema = new apache_arrow_1.Schema([
                new apache_arrow_1.Field('id', new apache_arrow_1.Int32()),
                new apache_arrow_1.Field('vector', new apache_arrow_1.FixedSizeList(dim, new apache_arrow_1.Field('item', new apache_arrow_1.Float16(), true)), false)
            ]);
            const data = lancedb.makeArrowTable(Array.from(Array(total), (_, i) => ({
                id: i,
                vector: Array.from(Array(dim), Math.random)
            })), { schema });
            const table = await con.createTable('f16', data);
            assert.equal(table.name, 'f16');
            assert.equal(await table.countRows(), total);
            assert.equal(await table.countRows('id < 5'), 5);
            assert.deepEqual(await con.tableNames(), ['f16']);
            assert.deepEqual(await table.schema, schema);
            await table.createIndex({
                num_sub_vectors: 2,
                num_partitions: 2,
                type: 'ivf_pq'
            });
            const q = Array.from(Array(dim), Math.random);
            const r = await table.search(q).limit(5).execute();
            assert.equal(r.length, 5);
            r.forEach((v) => {
                assert.equal(Object.prototype.hasOwnProperty.call(v, 'vector'), true);
                assert.equal(v.vector?.constructor.name, 'Array', 'vector column is list of floats');
            });
        }).timeout(120000);
        it('use overwrite flag to overwrite existing table', async function () {
            const dir = await (0, temp_1.track)().mkdir('lancejs');
            const con = await lancedb.connect(dir);
            const data = [
                { id: 1, vector: [0.1, 0.2], price: 10 },
                {
                    id: 2,
                    vector: [1.1, 1.2],
                    price: 50
                }
            ];
            const tableName = 'overwrite';
            await con.createTable(tableName, data, { writeMode: index_1.WriteMode.Create });
            const newData = [
                { id: 1, vector: [0.1, 0.2], price: 10 },
                { id: 2, vector: [1.1, 1.2], price: 50 },
                {
                    id: 3,
                    vector: [1.1, 1.2],
                    price: 50
                }
            ];
            await expect(con.createTable(tableName, newData)).to.be.rejectedWith(Error, 'already exists');
            const table = await con.createTable(tableName, newData, {
                writeMode: index_1.WriteMode.Overwrite
            });
            assert.equal(table.name, tableName);
            assert.equal(await table.countRows(), 3);
        });
        it('appends records to an existing table ', async function () {
            const dir = await (0, temp_1.track)().mkdir('lancejs');
            const con = await lancedb.connect(dir);
            const data = [
                {
                    id: 1,
                    vector: [0.1, 0.2],
                    price: 10,
                    name: 'a'
                },
                {
                    id: 2,
                    vector: [1.1, 1.2],
                    price: 50,
                    name: 'b'
                }
            ];
            const table = await con.createTable('vectors', data);
            assert.equal(await table.countRows(), 2);
            const dataAdd = [
                {
                    id: 3,
                    vector: [2.1, 2.2],
                    price: 10,
                    name: 'c'
                },
                {
                    id: 4,
                    vector: [3.1, 3.2],
                    price: 50,
                    name: 'd'
                }
            ];
            await table.add(dataAdd);
            assert.equal(await table.countRows(), 4);
        });
        it('appends records with fields in a different order', async function () {
            const dir = await (0, temp_1.track)().mkdir('lancejs');
            const con = await lancedb.connect(dir);
            const data = [
                {
                    id: 1,
                    vector: [0.1, 0.2],
                    price: 10,
                    name: 'a'
                },
                {
                    id: 2,
                    vector: [1.1, 1.2],
                    price: 50,
                    name: 'b'
                }
            ];
            const table = await con.createTable('vectors', data);
            const dataAdd = [
                {
                    id: 3,
                    vector: [2.1, 2.2],
                    name: 'c',
                    price: 10
                },
                {
                    id: 4,
                    vector: [3.1, 3.2],
                    name: 'd',
                    price: 50
                }
            ];
            await table.add(dataAdd);
            assert.equal(await table.countRows(), 4);
        });
        it('overwrite all records in a table', async function () {
            const uri = await createTestDB();
            const con = await lancedb.connect(uri);
            const table = await con.openTable('vectors');
            assert.equal(await table.countRows(), 2);
            const dataOver = [
                {
                    vector: [2.1, 2.2],
                    price: 10,
                    name: 'foo'
                },
                {
                    vector: [3.1, 3.2],
                    price: 50,
                    name: 'bar'
                }
            ];
            await table.overwrite(dataOver);
            assert.equal(await table.countRows(), 2);
        });
        it('can merge insert records into the table', async function () {
            const dir = await (0, temp_1.track)().mkdir('lancejs');
            const con = await lancedb.connect(dir);
            const data = [{ id: 1, age: 1 }, { id: 2, age: 1 }];
            const table = await con.createTable('my_table', data);
            // insert if not exists
            let newData = [{ id: 2, age: 2 }, { id: 3, age: 2 }];
            await table.mergeInsert('id', newData, {
                whenNotMatchedInsertAll: true
            });
            assert.equal(await table.countRows(), 3);
            assert.equal(await table.countRows('age = 2'), 1);
            // conditional update
            newData = [{ id: 2, age: 3 }, { id: 3, age: 3 }];
            await table.mergeInsert('id', newData, {
                whenMatchedUpdateAll: 'target.age = 1'
            });
            assert.equal(await table.countRows(), 3);
            assert.equal(await table.countRows('age = 1'), 1);
            assert.equal(await table.countRows('age = 3'), 1);
            newData = [{ id: 3, age: 4 }, { id: 4, age: 4 }];
            await table.mergeInsert('id', newData, {
                whenNotMatchedInsertAll: true,
                whenMatchedUpdateAll: true
            });
            assert.equal(await table.countRows(), 4);
            assert.equal((await table.filter('age = 4').execute()).length, 2);
            newData = [{ id: 5, age: 5 }];
            await table.mergeInsert('id', newData, {
                whenNotMatchedInsertAll: true,
                whenMatchedUpdateAll: true,
                whenNotMatchedBySourceDelete: 'age < 4'
            });
            assert.equal(await table.countRows(), 3);
            await table.mergeInsert('id', newData, {
                whenNotMatchedInsertAll: true,
                whenMatchedUpdateAll: true,
                whenNotMatchedBySourceDelete: true
            });
            assert.equal(await table.countRows(), 1);
        });
        it('can update records in the table', async function () {
            const uri = await createTestDB();
            const con = await lancedb.connect(uri);
            const table = await con.openTable('vectors');
            assert.equal(await table.countRows(), 2);
            await table.update({
                where: 'price = 10',
                valuesSql: { price: '100' }
            });
            const results = await table.search([0.1, 0.2]).execute();
            assert.equal(results[0].price, 100);
            assert.equal(results[1].price, 11);
        });
        it('can update the records using a literal value', async function () {
            const uri = await createTestDB();
            const con = await lancedb.connect(uri);
            const table = await con.openTable('vectors');
            assert.equal(await table.countRows(), 2);
            await table.update({
                where: 'price = 10',
                values: { price: 100 }
            });
            const results = await table.search([0.1, 0.2]).execute();
            assert.equal(results[0].price, 100);
            assert.equal(results[1].price, 11);
        });
        it('can update every record in the table', async function () {
            const uri = await createTestDB();
            const con = await lancedb.connect(uri);
            const table = await con.openTable('vectors');
            assert.equal(await table.countRows(), 2);
            await table.update({ valuesSql: { price: '100' } });
            const results = await table.search([0.1, 0.2]).execute();
            assert.equal(results[0].price, 100);
            assert.equal(results[1].price, 100);
        });
        it('can delete records from a table', async function () {
            const uri = await createTestDB();
            const con = await lancedb.connect(uri);
            const table = await con.openTable('vectors');
            assert.equal(await table.countRows(), 2);
            await table.delete('price = 10');
            assert.equal(await table.countRows(), 1);
        });
    });
    (0, mocha_1.describe)('when searching an empty dataset', function () {
        it('should not fail', async function () {
            const dir = await (0, temp_1.track)().mkdir('lancejs');
            const con = await lancedb.connect(dir);
            const schema = new apache_arrow_1.Schema([
                new apache_arrow_1.Field('vector', new apache_arrow_1.FixedSizeList(128, new apache_arrow_1.Field('float32', new apache_arrow_1.Float32())))
            ]);
            const table = await con.createTable({
                name: 'vectors',
                schema
            });
            const result = await table.search(Array(128).fill(0.1)).execute();
            assert.isEmpty(result);
        });
    });
    (0, mocha_1.describe)('when searching an empty-after-delete dataset', function () {
        it('should not fail', async function () {
            const dir = await (0, temp_1.track)().mkdir('lancejs');
            const con = await lancedb.connect(dir);
            const schema = new apache_arrow_1.Schema([
                new apache_arrow_1.Field('vector', new apache_arrow_1.FixedSizeList(128, new apache_arrow_1.Field('float32', new apache_arrow_1.Float32())))
            ]);
            const table = await con.createTable({
                name: 'vectors',
                schema
            });
            await table.add([{ vector: Array(128).fill(0.1) }]);
            // https://github.com/lancedb/lance/issues/1635
            await table.delete('true');
            const result = await table.search(Array(128).fill(0.1)).execute();
            assert.isEmpty(result);
        });
    });
    (0, mocha_1.describe)('when creating a vector index', function () {
        it('overwrite all records in a table', async function () {
            const uri = await createTestDB(32, 300);
            const con = await lancedb.connect(uri);
            const table = await con.openTable('vectors');
            await table.createIndex({
                type: 'ivf_pq',
                column: 'vector',
                num_partitions: 2,
                max_iters: 2,
                num_sub_vectors: 2
            });
        }).timeout(10000); // Timeout is high partially because GH macos runner is pretty slow
        it('replace an existing index', async function () {
            const uri = await createTestDB(16, 300);
            const con = await lancedb.connect(uri);
            const table = await con.openTable('vectors');
            await table.createIndex({
                type: 'ivf_pq',
                column: 'vector',
                num_partitions: 2,
                max_iters: 2,
                num_sub_vectors: 2
            });
            // Replace should fail if the index already exists
            await expect(table.createIndex({
                type: 'ivf_pq',
                column: 'vector',
                num_partitions: 2,
                max_iters: 2,
                num_sub_vectors: 2,
                replace: false
            })).to.be.rejectedWith('LanceError(Index)');
            // Default replace = true
            await table.createIndex({
                type: 'ivf_pq',
                column: 'vector',
                num_partitions: 2,
                max_iters: 2,
                num_sub_vectors: 2
            });
        }).timeout(50000);
        it('it should fail when the column is not a vector', async function () {
            const uri = await createTestDB(32, 300);
            const con = await lancedb.connect(uri);
            const table = await con.openTable('vectors');
            const createIndex = table.createIndex({
                type: 'ivf_pq',
                column: 'name',
                num_partitions: 2,
                max_iters: 2,
                num_sub_vectors: 2
            });
            await expect(createIndex).to.be.rejectedWith("index cannot be created on the column `name` which has data type Utf8");
        });
        it('it should fail when num_partitions is invalid', async function () {
            const uri = await createTestDB(32, 300);
            const con = await lancedb.connect(uri);
            const table = await con.openTable('vectors');
            const createIndex = table.createIndex({
                type: 'ivf_pq',
                column: 'name',
                num_partitions: -1,
                max_iters: 2,
                num_sub_vectors: 2
            });
            await expect(createIndex).to.be.rejectedWith('num_partitions: must be > 0');
        });
        it('should be able to list index and stats', async function () {
            const uri = await createTestDB(32, 300);
            const con = await lancedb.connect(uri);
            const table = await con.openTable('vectors');
            await table.createIndex({
                type: 'ivf_pq',
                column: 'vector',
                num_partitions: 2,
                max_iters: 2,
                num_sub_vectors: 2
            });
            const indices = await table.listIndices();
            expect(indices).to.have.lengthOf(1);
            expect(indices[0].name).to.equal('vector_idx');
            expect(indices[0].uuid).to.not.be.equal(undefined);
            expect(indices[0].columns).to.have.lengthOf(1);
            expect(indices[0].columns[0]).to.equal('vector');
            const stats = await table.indexStats(indices[0].uuid);
            expect(stats.numIndexedRows).to.equal(300);
            expect(stats.numUnindexedRows).to.equal(0);
        }).timeout(50000);
    });
    (0, mocha_1.describe)('when using a custom embedding function', function () {
        class TextEmbedding {
            constructor(targetColumn) {
                this._embedding_map = new Map([
                    ['foo', [2.1, 2.2]],
                    ['bar', [3.1, 3.2]]
                ]);
                this.sourceColumn = targetColumn;
            }
            async embed(data) {
                return data.map((datum) => this._embedding_map.get(datum) ?? [0.0, 0.0]);
            }
        }
        it('should encode the original data into embeddings', async function () {
            const dir = await (0, temp_1.track)().mkdir('lancejs');
            const con = await lancedb.connect(dir);
            const embeddings = new TextEmbedding('name');
            const data = [
                {
                    price: 10,
                    name: 'foo'
                },
                {
                    price: 50,
                    name: 'bar'
                }
            ];
            const table = await con.createTable('vectors', data, embeddings, {
                writeMode: index_1.WriteMode.Create
            });
            const results = await table.search('foo').execute();
            assert.equal(results.length, 2);
        });
        it('should create embeddings for Arrow Table', async function () {
            const dir = await (0, temp_1.track)().mkdir('lancejs');
            const con = await lancedb.connect(dir);
            const embeddingFunction = new TextEmbedding('name');
            const names = (0, apache_arrow_1.vectorFromArray)(['foo', 'bar'], new apache_arrow_1.Utf8());
            const data = new apache_arrow_1.Table({ name: names });
            const table = await con.createTable({
                name: 'vectors',
                data,
                embeddingFunction
            });
            assert.equal(table.name, 'vectors');
            const results = await table.search('foo').execute();
            assert.equal(results.length, 2);
        });
    });
    (0, mocha_1.describe)('when inspecting the schema', function () {
        it('should return the schema', async function () {
            const uri = await createTestDB();
            const db = await lancedb.connect(uri);
            // the fsl inner field must be named 'item' and be nullable
            const expectedSchema = new apache_arrow_1.Schema([
                new apache_arrow_1.Field('id', new apache_arrow_1.Int32()),
                new apache_arrow_1.Field('vector', new apache_arrow_1.FixedSizeList(128, new apache_arrow_1.Field('item', new apache_arrow_1.Float32(), true))),
                new apache_arrow_1.Field('s', new apache_arrow_1.Utf8())
            ]);
            const table = await db.createTable({
                name: 'some_table',
                schema: expectedSchema
            });
            const schema = await table.schema;
            assert.deepEqual(expectedSchema, schema);
        });
    });
});
(0, mocha_1.describe)('Remote LanceDB client', function () {
    (0, mocha_1.describe)('when the server is not reachable', function () {
        it('produces a network error', async function () {
            const con = await lancedb.connect({
                uri: 'db://test-1234',
                region: 'asdfasfasfdf',
                apiKey: 'some-api-key'
            });
            // GET
            try {
                await con.tableNames();
            }
            catch (err) {
                expect(err).to.have.property('message', 'Network Error: getaddrinfo ENOTFOUND test-1234.asdfasfasfdf.api.lancedb.com');
            }
            // POST
            try {
                await con.createTable({
                    name: 'vectors',
                    schema: new apache_arrow_1.Schema([])
                });
            }
            catch (err) {
                expect(err).to.have.property('message', 'Network Error: getaddrinfo ENOTFOUND test-1234.asdfasfasfdf.api.lancedb.com');
            }
            // Search
            const table = await con.withMiddleware(new (class {
                async onRemoteRequest(req, next) {
                    // intercept call to check if the table exists and make the call succeed
                    if (req.uri.endsWith('/describe/')) {
                        return {
                            status: 200,
                            statusText: 'OK',
                            headers: new Map(),
                            body: async () => ({})
                        };
                    }
                    return await next(req);
                }
            })()).openTable('vectors');
            try {
                await table.search([0.1, 0.3]).execute();
            }
            catch (err) {
                expect(err).to.have.property('message', 'Network Error: getaddrinfo ENOTFOUND test-1234.asdfasfasfdf.api.lancedb.com');
            }
        });
    });
});
(0, mocha_1.describe)('Query object', function () {
    it('sets custom parameters', async function () {
        const query = new index_1.Query([0.1, 0.3])
            .limit(1)
            .metricType(index_1.MetricType.Cosine)
            .refineFactor(100)
            .select(['a', 'b'])
            .nprobes(20);
        assert.equal(query._limit, 1);
        assert.equal(query._metricType, index_1.MetricType.Cosine);
        assert.equal(query._refineFactor, 100);
        assert.equal(query._nprobes, 20);
        assert.deepEqual(query._select, ['a', 'b']);
    });
});
async function createTestDB(numDimensions = 2, numRows = 2) {
    const dir = await (0, temp_1.track)().mkdir('lancejs');
    const con = await lancedb.connect(dir);
    const data = [];
    for (let i = 0; i < numRows; i++) {
        const vector = [];
        for (let j = 0; j < numDimensions; j++) {
            vector.push(i + j * 0.1);
        }
        data.push({
            id: i + 1,
            name: `name_${i}`,
            price: i + 10,
            is_active: i % 2 === 0,
            vector
        });
    }
    await con.createTable('vectors', data);
    return dir;
}
(0, mocha_1.describe)('Drop table', function () {
    it('drop a table', async function () {
        const dir = await (0, temp_1.track)().mkdir('lancejs');
        const con = await lancedb.connect(dir);
        const data = [
            {
                price: 10,
                name: 'foo',
                vector: [1, 2, 3]
            },
            {
                price: 50,
                name: 'bar',
                vector: [4, 5, 6]
            }
        ];
        await con.createTable('t1', data);
        await con.createTable('t2', data);
        assert.deepEqual(await con.tableNames(), ['t1', 't2']);
        await con.dropTable('t1');
        assert.deepEqual(await con.tableNames(), ['t2']);
    });
});
(0, mocha_1.describe)('WriteOptions', function () {
    context('#isWriteOptions', function () {
        it('should not match empty object', function () {
            assert.equal((0, index_1.isWriteOptions)({}), false);
        });
        it('should match write options', function () {
            assert.equal((0, index_1.isWriteOptions)({ writeMode: index_1.WriteMode.Create }), true);
        });
        it('should match undefined write mode', function () {
            assert.equal((0, index_1.isWriteOptions)({ writeMode: undefined }), true);
        });
        it('should match default write options', function () {
            assert.equal((0, index_1.isWriteOptions)(new index_1.DefaultWriteOptions()), true);
        });
    });
});
(0, mocha_1.describe)('Compact and cleanup', function () {
    it('can cleanup after compaction', async function () {
        const dir = await (0, temp_1.track)().mkdir('lancejs');
        const con = await lancedb.connect(dir);
        const data = [
            {
                price: 10,
                name: 'foo',
                vector: [1, 2, 3]
            },
            {
                price: 50,
                name: 'bar',
                vector: [4, 5, 6]
            }
        ];
        const table = (await con.createTable('t1', data));
        const newData = [
            {
                price: 30,
                name: 'baz',
                vector: [7, 8, 9]
            }
        ];
        await table.add(newData);
        const compactionMetrics = await table.compactFiles({
            numThreads: 2
        });
        assert.equal(compactionMetrics.fragmentsRemoved, 2);
        assert.equal(compactionMetrics.fragmentsAdded, 1);
        assert.equal(await table.countRows(), 3);
        await table.cleanupOldVersions();
        assert.equal(await table.countRows(), 3);
        // should have no effect, but this validates the arguments are parsed.
        await table.compactFiles({
            targetRowsPerFragment: 102410,
            maxRowsPerGroup: 1024,
            materializeDeletions: true,
            materializeDeletionsThreshold: 0.5,
            numThreads: 2
        });
        const cleanupMetrics = await table.cleanupOldVersions(0, true);
        assert.isAtLeast(cleanupMetrics.bytesRemoved, 1);
        assert.isAtLeast(cleanupMetrics.oldVersions, 1);
        assert.equal(await table.countRows(), 3);
    });
});
(0, mocha_1.describe)('schema evolution', function () {
    // Create a new sample table
    it('can add a new column to the schema', async function () {
        const dir = await (0, temp_1.track)().mkdir('lancejs');
        const con = await lancedb.connect(dir);
        const table = await con.createTable('vectors', [
            { id: 1n, vector: [0.1, 0.2] }
        ]);
        await table.addColumns([{ name: 'price', valueSql: 'cast(10.0 as float)' }]);
        const expectedSchema = new apache_arrow_1.Schema([
            new apache_arrow_1.Field('id', new apache_arrow_1.Int64()),
            new apache_arrow_1.Field('vector', new apache_arrow_1.FixedSizeList(2, new apache_arrow_1.Field('item', new apache_arrow_1.Float32(), true))),
            new apache_arrow_1.Field('price', new apache_arrow_1.Float32())
        ]);
        expect(await table.schema).to.deep.equal(expectedSchema);
    });
    it('can alter the columns in the schema', async function () {
        const dir = await (0, temp_1.track)().mkdir('lancejs');
        const con = await lancedb.connect(dir);
        const schema = new apache_arrow_1.Schema([
            new apache_arrow_1.Field('id', new apache_arrow_1.Int64(), false),
            new apache_arrow_1.Field('vector', new apache_arrow_1.FixedSizeList(2, new apache_arrow_1.Field('item', new apache_arrow_1.Float32(), true))),
            new apache_arrow_1.Field('price', new apache_arrow_1.Float64(), false)
        ]);
        const table = await con.createTable('vectors', [
            { id: 1n, vector: [0.1, 0.2], price: 10.0 }
        ]);
        expect(await table.schema).to.deep.equal(schema);
        await table.alterColumns([
            { path: 'id', rename: 'new_id' },
            { path: 'price', nullable: true }
        ]);
        const expectedSchema = new apache_arrow_1.Schema([
            new apache_arrow_1.Field('new_id', new apache_arrow_1.Int64(), false),
            new apache_arrow_1.Field('vector', new apache_arrow_1.FixedSizeList(2, new apache_arrow_1.Field('item', new apache_arrow_1.Float32(), true))),
            new apache_arrow_1.Field('price', new apache_arrow_1.Float64(), true)
        ]);
        expect(await table.schema).to.deep.equal(expectedSchema);
    });
    it('can drop a column from the schema', async function () {
        const dir = await (0, temp_1.track)().mkdir('lancejs');
        const con = await lancedb.connect(dir);
        const table = await con.createTable('vectors', [
            { id: 1n, vector: [0.1, 0.2] }
        ]);
        await table.dropColumns(['vector']);
        const expectedSchema = new apache_arrow_1.Schema([
            new apache_arrow_1.Field('id', new apache_arrow_1.Int64(), false)
        ]);
        expect(await table.schema).to.deep.equal(expectedSchema);
    });
});
//# sourceMappingURL=test.js.map