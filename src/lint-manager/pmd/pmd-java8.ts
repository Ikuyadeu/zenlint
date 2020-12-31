import * as csvparser from 'csv-parse/lib/sync';
import { validate, parse as xmlparse } from 'fast-xml-parser';
import { Options } from 'csv-parse';
import { EOL } from 'os';
import { exec } from 'child_process';
import { Result } from 'sarif';

import { LintManager } from '../lint-manager';
import { RuleMap } from '../rule-map';
import { allRule, makeFullRuleID, makeShortRuleID } from './pmd-java8-rules';
import { tryReadFile } from '../../util';

interface PmdConfig {
  ruleset: {
    description: string
    rule: {
      ref: string
    }[]
  }
}

interface PmdResult {
  problem: string;
  package: string;
  file: string;
  priority: string;
  line: string;
  description: string;
  ruleSet: string;
  rule: string;
}

const PMD_COLUMNS: (keyof PmdResult)[] = [
  'problem',
  'package',
  'file',
  'priority',
  'line',
  'description',
  'ruleSet',
  'rule',
];

export function parsePmdCsv(csv: string): Array<PmdResult> {
  let results: PmdResult[];
  const parseOpts: Options = {
    columns: PMD_COLUMNS,
    relax_column_count: true,
  };
  try {
    results = csvparser(csv, parseOpts) as PmdResult[];
  } catch (e) {
    //try to recover parsing... remove last ln and try again
    const lines = csv.split(EOL);
    lines.pop();
    csv = lines.join(EOL);
    try {
      results = csvparser(csv, parseOpts) as PmdResult[];
    } catch (e) {
      throw new Error(
        'Failed to parse PMD Results.  Enable please logging (STDOUT & STDERROR) and submit an issue if this problem persists.'
      );
    }
    console.error('Failed to read all PMD problems!');
  }
  return results;
}


function readConfig(xmlPath:string): PmdConfig {
    // xmlを開く
    const contents = tryReadFile(xmlPath);
    if (contents === undefined) {
      throw new Error(
        'Failed to read PMD Config.'
      );
    }
    const options = {
      attributeNamePrefix : '',
      ignoreAttributes : false,
      parseAttributeValue : true,
    };
    if(validate(contents) === true) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      try {
        const jsonObj = xmlparse(contents, options) as PmdConfig;
        return jsonObj;
      } catch (error) {
        console.error(error);
        throw new Error(
          'Failed to parse PMD Config.'
        );
      }
    }
    throw new Error(
      'Failed to parse PMD Config as XML.'
    );
}


function collectRuleIdfromXML(xmlPath:string) {
  const config = readConfig(xmlPath);
  const rules = [];
  for (const rule of config.ruleset.rule) {
    rules.push(rule.ref);
  }
  return rules;
}

function pmdJson2Sarif(pmdResults: Array<PmdResult>): Result[] {
  const output: Result[] = [];
  for (const pmdResult of pmdResults) {
    output.push({
      message: { text: pmdResult.description },
      ruleId: pmdResult.rule,
    });
  }
  return output;
}

function makePMDCommand(dirName: string, pmdPath: string) {
  const PMD_CATEGORY = [
    'bestpractices',
    'codestyle',
    'design',
    'documentation',
    'errorprone',
    'multithreading',
    'performance',
    'security'
  ].map(x => {
    return `category/java/${x}.xml`;
  });

  // pmd -d ./test/ -f text -rulesets rulesets/java/quickstart.xml,category/java/codestyle.xml
  return  [pmdPath, '-d', dirName, '-f', 'csv', '-rulesets', PMD_CATEGORY.join(',')];
}


export class PMDManager extends LintManager {
  pmdPath: string;
  configPath?: string;

  constructor (projectPath: string, pmdPath?: string, configPath?: string){
    super(projectPath);
    this.pmdPath = pmdPath? pmdPath: 'pmd';
    this.configPath = configPath;
  }

  execute (cmd: string[]): Promise<Result[]> {
    let result: Result[] = [];
    const pmdCmd = exec(cmd.join(' '), {});
    const pmdPromise = new Promise<Result[]>((resolve, reject) => {
      pmdCmd.addListener('error', (e) => {
        console.error(e);
        reject(e);
      });
      pmdCmd.addListener('exit', () => {
        resolve(result);
      });
  
      pmdCmd.stdout?.on('data', (stdout: string) => {
        const output = parsePmdCsv(stdout);
        result = pmdJson2Sarif(output);
      });
      if (pmdCmd.stderr) {
        pmdCmd.stderr.on('data', (m: string) => {
          console.error(`error: ${m}`);
        });
      }
      
    });
  
    return pmdPromise;
  }

  getAvailableRules(): string[] {
    return allRule;
  }
  
  async makeRuleMap(): Promise<RuleMap | undefined> {
    const command = makePMDCommand(this.projectPath, this.pmdPath);
    const results = await this.execute(command);

    const unfollowed = this.results2warnings(results);
    const enabled = this.configPath? collectRuleIdfromXML(this.configPath): [];
    return new RuleMap(this.getAvailableRules(), unfollowed, enabled.map(x => makeShortRuleID(x)));
  }
  
  async makeConfigFile(): Promise<string> {
    const ruleMap = await this.makeRuleMap();
    if (ruleMap !== undefined) {
      const head = [
        '<?xml version="1.0"?>',
        '<ruleset name="yourrule"',
        'xmlns="http://pmd.sourceforge.net/ruleset/2.0.0"',
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
        'xsi:schemaLocation="http://pmd.sourceforge.net/ruleset/2.0.0 https://pmd.sourceforge.io/ruleset_2_0_0.xsd">',
        '<description>Your configuration of PMD. Includes the rules that are most likely to apply for you.</description>'];
      const rules = ruleMap.followed.map(x => `<rule ref="${makeFullRuleID(x)}"/>`);
      const tail = '</ruleset>';     

      const content = [...head, ...rules, tail].join('\n');
      return content;
    }
    throw new Error(
      'Failed to generate PMD Config'
    );
  }
}
