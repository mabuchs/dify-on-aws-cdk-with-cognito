import { Construct } from 'constructs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Connections, IConnectable, IVpc } from 'aws-cdk-lib/aws-ec2';
import { CfnOutput, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';

export interface PostgresProps {
  vpc: IVpc;
}

export class Postgres extends Construct implements IConnectable {
  public readonly connections: Connections;
  public readonly cluster: rds.DatabaseCluster;
  public readonly secret: ISecret;
  public readonly databaseName: string = 'main';

  private queries: AwsCustomResource[] = [];

  constructor(scope: Construct, id: string, props: PostgresProps) {
    super(scope, id);

    const { vpc } = props;

    const cluster = new rds.DatabaseCluster(this, 'Cluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_5,
      }),
      vpc,
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 2.0,
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        autoMinorVersionUpgrade: true,
        publiclyAccessible: false,
      }),
      defaultDatabaseName: this.databaseName,
      enableDataApi: true,
      storageEncrypted: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const host = new ec2.BastionHostLinux(this, 'BastionHost', {
      vpc,
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      blockDevices: [
        {
          deviceName: '/dev/sdf',
          volume: ec2.BlockDeviceVolume.ebs(8, {
            encrypted: true,
          }),
        },
      ],
    });

    new CfnOutput(this, 'PortForwardCommand', {
      value: `aws ssm start-session --region ${Stack.of(this).region} --target ${
        host.instanceId
      } --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters '{"portNumber":["${
        cluster.clusterEndpoint.port
      }"], "localPortNumber":["${cluster.clusterEndpoint.port}"], "host": ["${cluster.clusterEndpoint.hostname}"]}'`,
    });
    new CfnOutput(this, 'DatabaseSecretsCommand', {
      value: `aws secretsmanager get-secret-value --secret-id ${cluster.secret!.secretName} --region ${Stack.of(this).region}`,
    });

    this.connections = cluster.connections;
    this.cluster = cluster;
    this.secret = cluster.secret!;

    this.runQuery('CREATE DATABASE dify;', undefined);
    this.runQuery('CREATE EXTENSION IF NOT EXISTS vector;', 'dify');
  }

  private runQuery(sql: string, database: string | undefined) {
    const cluster = this.cluster;
    const query = new AwsCustomResource(this, `Query${this.queries.length}`, {
      onUpdate: {
        // will also be called for a CREATE event
        service: 'rds-data',
        action: 'ExecuteStatement',
        parameters: {
          resourceArn: cluster.clusterArn,
          secretArn: cluster.secret!.secretArn,
          database: database,
          sql: sql,
        },
        physicalResourceId: PhysicalResourceId.of(cluster.clusterArn),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: [cluster.clusterArn] }),
    });
    cluster.secret!.grantRead(query);
    cluster.grantDataApiAccess(query);
    if (this.queries.length > 0) {
      // 雑に直列実行を仮定
      query.node.addDependency(this.queries.at(-1)!);
    }
    this.queries.push(query);
    return query;
  }
}