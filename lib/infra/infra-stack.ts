/* Copyright OpenSearch Contributors
SPDX-License-Identifier: Apache-2.0

The OpenSearch Contributors require contributions made to
this file be licensed under the Apache-2.0 license or a
compatible open source license. */

import {
  CfnOutput, RemovalPolicy, Stack, StackProps, Tags,
} from 'aws-cdk-lib';
import {
  AutoScalingGroup, BlockDeviceVolume, EbsDeviceVolumeType, Signals,
} from 'aws-cdk-lib/aws-autoscaling';
import {
  AmazonLinuxCpuType,
  AmazonLinuxGeneration,
  CloudFormationInit,
  ISecurityGroup,
  IVpc,
  InitCommand,
  InitElement,
  InitPackage,
  Instance,
  InstanceClass,
  InstanceSize,
  InstanceType,
  MachineImage,
  SubnetType, InitFile,
} from 'aws-cdk-lib/aws-ec2';
import {
  CfnLoadBalancer, NetworkListener, NetworkLoadBalancer, Protocol,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { InstanceTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import {
  Effect,
  ManagedPolicy, PolicyStatement, Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { readFileSync } from 'fs';
import { dump, load } from 'js-yaml';
import { join } from 'path';
import { CloudwatchAgent } from '../cloudwatch/cloudwatch-agent';
import { nodeConfig } from '../opensearch-config/node-config';
import { RemoteStoreResources } from './remote-store-resources';

export interface infraProps extends StackProps {
  readonly vpc: IVpc,
  readonly securityGroup: ISecurityGroup,
  readonly opensearchVersion: string,
  readonly cpuArch: string,
  readonly cpuType: AmazonLinuxCpuType,
  readonly securityDisabled: boolean,
  readonly minDistribution: boolean,
  readonly distributionUrl: string,
  readonly captureProxyEnabled: string,
  readonly captureProxyTarUrl: string,
  readonly dashboardsUrl: string,
  readonly singleNodeCluster: boolean,
  readonly managerNodeCount: number,
  readonly dataNodeCount: number,
  readonly ingestNodeCount: number,
  readonly clientNodeCount: number,
  readonly mlNodeCount: number,
  readonly dataNodeStorage: number,
  readonly mlNodeStorage: number,
  readonly jvmSysPropsString?: string,
  readonly additionalConfig?: string,
  readonly additionalOsdConfig?: string,
  readonly dataEc2InstanceType: InstanceType,
  readonly mlEc2InstanceType: InstanceType,
  readonly use50PercentHeap: boolean,
  readonly isInternal: boolean,
  readonly enableRemoteStore: boolean,
  readonly storageVolumeType: EbsDeviceVolumeType,
  readonly customRoleArn: string
}

export class InfraStack extends Stack {
  private instanceRole: Role;

  addKafkaProducerIAMPolicies(role: Role) {
    const mskClusterArn = `arn:aws:kafka:${this.region}:${this.account}:cluster/migration-msk-cluster-*/*`;
    const mskClusterConnectPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      resources: [mskClusterArn],
      actions: [
        'kafka-cluster:Connect',
      ],
    });
    const mskClusterAllTopicArn = `arn:aws:kafka:${this.region}:${this.account}:topic/migration-msk-cluster-*/*`;
    const mskTopicProducerPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      resources: [mskClusterAllTopicArn],
      actions: [
        'kafka-cluster:CreateTopic',
        'kafka-cluster:DescribeTopic',
        'kafka-cluster:WriteData',
      ],
    });
    role.addToPolicy(mskClusterConnectPolicy);
    role.addToPolicy(mskTopicProducerPolicy);
  }

  constructor(scope: Stack, id: string, props: infraProps) {
    super(scope, id, props);
    let opensearchListener: NetworkListener;
    let opensearchListener19200: NetworkListener;
    let dashboardsListener: NetworkListener;
    let managerAsgCapacity: number;
    let dataAsgCapacity: number;
    let clientNodeAsg: AutoScalingGroup;
    let seedConfig: string;
    let hostType: InstanceType;
    let singleNodeInstance: Instance;

    const clusterLogGroup = new LogGroup(this, 'elasticsearchLogGroup', {
      logGroupName: `${id}LogGroup/elasticsearch.log`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    if (props.customRoleArn === 'undefined') {
      this.instanceRole = new Role(this, 'instanceRole', {
        managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ReadOnlyAccess'),
          ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
          ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
        assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      });
    } else {
      this.instanceRole = <Role>Role.fromRoleArn(this, 'custom-role-arn', `${props.customRoleArn}`);
    }
    if (props.captureProxyEnabled) {
      this.addKafkaProducerIAMPolicies(this.instanceRole);
    }

    if (props.enableRemoteStore) {
      // Remote Store needs an S3 bucket to be registered as snapshot repo
      // Add scoped bucket policy to the instance role attached to the EC2
      const remoteStoreObj = new RemoteStoreResources(this);
      this.instanceRole.addToPolicy(remoteStoreObj.getRemoteStoreBucketPolicy());
    }

    let singleNodeInstanceType: InstanceType;
    if (props.dataEc2InstanceType) {
      singleNodeInstanceType = props.dataEc2InstanceType;
    } else if (props.cpuType === AmazonLinuxCpuType.X86_64) {
      singleNodeInstanceType = InstanceType.of(InstanceClass.R5, InstanceSize.XLARGE);
    } else {
      singleNodeInstanceType = InstanceType.of(InstanceClass.R6G, InstanceSize.XLARGE);
    }

    const defaultInstanceType = (props.cpuType === AmazonLinuxCpuType.X86_64)
      ? InstanceType.of(InstanceClass.C5, InstanceSize.XLARGE) : InstanceType.of(InstanceClass.C6G, InstanceSize.XLARGE);

    const nlb = new NetworkLoadBalancer(this, 'clusterNlb', {
      vpc: props.vpc,
      internetFacing: (!props.isInternal),
      crossZoneEnabled: true,
    });

    if (!props.securityDisabled && !props.minDistribution) {
      opensearchListener = nlb.addListener('elasticsearchHTTPS', {
        port: 443,
        protocol: Protocol.TCP,
      });
      opensearchListener19200 = nlb.addListener('elasticsearchHTTP', {
        port: 80, // or some other port that makes sense in this context
        protocol: Protocol.TCP,
      });
    } else {
      opensearchListener = nlb.addListener('elasticsearch9200', {
        port: 9200,
        protocol: Protocol.TCP,
      });
      opensearchListener19200 = nlb.addListener('elasticsearch19200', {
        port: 19200,
        protocol: Protocol.TCP,
      });
    }

    if (props.dashboardsUrl !== 'undefined') {
      dashboardsListener = nlb.addListener('dashboards', {
        port: 8443,
        protocol: Protocol.TCP,
      });
    }

    // Workaround to add security group to NLB - see https://github.com/aws/aws-cdk/issues/26735
    const cfnlb = (nlb.node.defaultChild as CfnLoadBalancer);
    cfnlb.addPropertyOverride('SecurityGroups', [
      props.securityGroup.securityGroupId,
    ]);

    if (props.singleNodeCluster) {
      console.log('Single node value is true, creating single node configurations');
      singleNodeInstance = new Instance(this, 'single-node-instance', {
        vpc: props.vpc,
        instanceType: singleNodeInstanceType,
        machineImage: MachineImage.latestAmazonLinux({
          generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
          cpuType: props.cpuType,
        }),
        role: this.instanceRole,
        vpcSubnets: {
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        securityGroup: props.securityGroup,
        blockDevices: [{
          deviceName: '/dev/xvda',
          volume: BlockDeviceVolume.ebs(props.dataNodeStorage, { deleteOnTermination: true, volumeType: props.storageVolumeType }),
        }],
        init: CloudFormationInit.fromElements(...InfraStack.getCfnInitElement(this, clusterLogGroup, props)),
        initOptions: {
          ignoreFailures: false,
        },
        requireImdsv2: true,
      });
      Tags.of(singleNodeInstance).add('role', 'client');

      opensearchListener.addTargets('single-node-target', {
        port: 9200,
        targets: [new InstanceTarget(singleNodeInstance)],
      });
      opensearchListener19200.addTargets('single-node-target', {
        port: 19200,
        targets: [new InstanceTarget(singleNodeInstance)],
      });

      if (props.dashboardsUrl !== 'undefined') {
        // @ts-ignore
        dashboardsListener.addTargets('single-node-osd-target', {
          port: 5601,
          targets: [new InstanceTarget(singleNodeInstance)],
        });
      }
      new CfnOutput(this, 'private-ip', {
        value: singleNodeInstance.instancePrivateIp,
      });
    } else {
      if (props.managerNodeCount > 0) {
        managerAsgCapacity = props.managerNodeCount - 1;
        dataAsgCapacity = props.dataNodeCount;
      } else {
        managerAsgCapacity = props.managerNodeCount;
        dataAsgCapacity = props.dataNodeCount - 1;
      }

      if (managerAsgCapacity > 0) {
        const managerNodeAsg = new AutoScalingGroup(this, 'managerNodeAsg', {
          vpc: props.vpc,
          instanceType: defaultInstanceType,
          machineImage: MachineImage.latestAmazonLinux({
            generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
            cpuType: props.cpuType,
          }),
          role: this.instanceRole,
          maxCapacity: managerAsgCapacity,
          minCapacity: managerAsgCapacity,
          desiredCapacity: managerAsgCapacity,
          vpcSubnets: {
            subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          },
          securityGroup: props.securityGroup,
          blockDevices: [{
            deviceName: '/dev/xvda',
            volume: BlockDeviceVolume.ebs(50, { deleteOnTermination: true, volumeType: props.storageVolumeType }),
          }],
          init: CloudFormationInit.fromElements(...InfraStack.getCfnInitElement(this, clusterLogGroup, props, 'manager')),
          initOptions: {
            ignoreFailures: false,
          },
          requireImdsv2: true,
          signals: Signals.waitForAll(),
        });
        Tags.of(managerNodeAsg).add('role', 'manager');

        seedConfig = 'seed-manager';
      } else {
        seedConfig = 'seed-data';
      }

      const seedNodeAsg = new AutoScalingGroup(this, 'seedNodeAsg', {
        vpc: props.vpc,
        instanceType: (seedConfig === 'seed-manager') ? defaultInstanceType : props.dataEc2InstanceType,
        machineImage: MachineImage.latestAmazonLinux({
          generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
          cpuType: props.cpuType,
        }),
        role: this.instanceRole,
        maxCapacity: 1,
        minCapacity: 1,
        desiredCapacity: 1,
        vpcSubnets: {
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        securityGroup: props.securityGroup,
        blockDevices: [{
          deviceName: '/dev/xvda',
          // eslint-disable-next-line max-len
          volume: (seedConfig === 'seed-manager') ? BlockDeviceVolume.ebs(50, { deleteOnTermination: true, volumeType: props.storageVolumeType }) : BlockDeviceVolume.ebs(props.dataNodeStorage, { deleteOnTermination: true, volumeType: props.storageVolumeType }),
        }],
        init: CloudFormationInit.fromElements(...InfraStack.getCfnInitElement(this, clusterLogGroup, props, seedConfig)),
        initOptions: {
          ignoreFailures: false,
        },
        requireImdsv2: true,
        signals: Signals.waitForAll(),
      });
      Tags.of(seedNodeAsg).add('role', 'manager');

      const dataNodeAsg = new AutoScalingGroup(this, 'dataNodeAsg', {
        vpc: props.vpc,
        instanceType: props.dataEc2InstanceType,
        machineImage: MachineImage.latestAmazonLinux({
          generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
          cpuType: props.cpuType,
        }),
        role: this.instanceRole,
        maxCapacity: dataAsgCapacity,
        minCapacity: dataAsgCapacity,
        desiredCapacity: dataAsgCapacity,
        vpcSubnets: {
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        securityGroup: props.securityGroup,
        blockDevices: [{
          deviceName: '/dev/xvda',
          volume: BlockDeviceVolume.ebs(props.dataNodeStorage, { deleteOnTermination: true, volumeType: props.storageVolumeType }),
        }],
        init: CloudFormationInit.fromElements(...InfraStack.getCfnInitElement(this, clusterLogGroup, props, 'data')),
        initOptions: {
          ignoreFailures: false,
        },
        requireImdsv2: true,
        signals: Signals.waitForAll(),
      });
      Tags.of(dataNodeAsg).add('role', 'data');

      if (props.clientNodeCount === 0) {
        clientNodeAsg = dataNodeAsg;
      } else {
        clientNodeAsg = new AutoScalingGroup(this, 'clientNodeAsg', {
          vpc: props.vpc,
          instanceType: defaultInstanceType,
          machineImage: MachineImage.latestAmazonLinux({
            generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
            cpuType: props.cpuType,
          }),
          role: this.instanceRole,
          maxCapacity: props.clientNodeCount,
          minCapacity: props.clientNodeCount,
          desiredCapacity: props.clientNodeCount,
          vpcSubnets: {
            subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          },
          securityGroup: props.securityGroup,
          blockDevices: [{
            deviceName: '/dev/xvda',
            volume: BlockDeviceVolume.ebs(50, { deleteOnTermination: true, volumeType: props.storageVolumeType }),
          }],
          init: CloudFormationInit.fromElements(...InfraStack.getCfnInitElement(this, clusterLogGroup, props, 'client')),
          initOptions: {
            ignoreFailures: false,
          },
          requireImdsv2: true,
          signals: Signals.waitForAll(),
        });
        Tags.of(clientNodeAsg).add('cluster', scope.stackName);
      }

      Tags.of(clientNodeAsg).add('role', 'client');

      if (props.mlNodeCount > 0) {
        const mlNodeAsg = new AutoScalingGroup(this, 'mlNodeAsg', {
          vpc: props.vpc,
          instanceType: props.mlEc2InstanceType,
          machineImage: MachineImage.latestAmazonLinux({
            generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
            cpuType: props.cpuType,
          }),
          role: this.instanceRole,
          maxCapacity: props.mlNodeCount,
          minCapacity: props.mlNodeCount,
          desiredCapacity: props.mlNodeCount,
          vpcSubnets: {
            subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          },
          securityGroup: props.securityGroup,
          blockDevices: [{
            deviceName: '/dev/xvda',
            volume: BlockDeviceVolume.ebs(props.mlNodeStorage, { deleteOnTermination: true, volumeType: props.storageVolumeType }),
          }],
          init: CloudFormationInit.fromElements(...InfraStack.getCfnInitElement(this, clusterLogGroup, props, 'ml')),
          initOptions: {
            ignoreFailures: false,
          },
          requireImdsv2: true,
          signals: Signals.waitForAll(),
        });

        Tags.of(mlNodeAsg).add('role', 'ml-node');
      }

      opensearchListener.addTargets('elasticsearchTarget', {
        port: 9200,
        targets: [clientNodeAsg],
      });
      opensearchListener19200.addTargets('elasticsearchTarget', {
        port: 19200,
        targets: [clientNodeAsg],
      });

      if (props.dashboardsUrl !== 'undefined') {
        // @ts-ignore
        dashboardsListener.addTargets('dashboardsTarget', {
          port: 5601,
          targets: [clientNodeAsg],
        });
      }
    }

    new CfnOutput(this, 'loadbalancer-url', {
      value: nlb.loadBalancerDnsName,
    });
  }

  private static getCfnInitElement(scope: Stack, logGroup: LogGroup, props: infraProps, nodeType?: string): InitElement[] {
    const configFileDir = join(__dirname, '../opensearch-config');
    let opensearchConfig: string;

    const cfnInitConfig: InitElement[] = [
      InitPackage.yum('amazon-cloudwatch-agent'),
      CloudwatchAgent.asInitFile('/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json',
        {
          agent: {
            metrics_collection_interval: 60,
            logfile: '/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log',
            omit_hostname: true,
            debug: false,
          },
          metrics: {
            metrics_collected: {
              cpu: {
                measurement: [
                  // eslint-disable-next-line max-len
                  'usage_active', 'usage_guest', 'usage_guest_nice', 'usage_idle', 'usage_iowait', 'usage_irq', 'usage_nice', 'usage_softirq', 'usage_steal', 'usage_system', 'usage_user', 'time_active', 'time_iowait', 'time_system', 'time_user',
                ],
              },
              disk: {
                measurement: [
                  'free', 'total', 'used', 'used_percent', 'inodes_free', 'inodes_used', 'inodes_total',
                ],
              },
              diskio: {
                measurement: [
                  'reads', 'writes', 'read_bytes', 'write_bytes', 'read_time', 'write_time', 'io_time',
                ],
              },
              mem: {
                measurement: [
                  'active', 'available', 'available_percent', 'buffered', 'cached', 'free', 'inactive', 'total', 'used', 'used_percent',
                ],
              },
              net: {
                measurement: [
                  'bytes_sent', 'bytes_recv', 'drop_in', 'drop_out', 'err_in', 'err_out', 'packets_sent', 'packets_recv',
                ],
              },
            },
          },
          logs: {
            logs_collected: {
              files: {
                collect_list: [
                  {
                    file_path: `/home/ec2-user/elasticsearch/logs/${scope.stackName}-${scope.account}-${scope.region}.log`,
                    log_group_name: `${logGroup.logGroupName.toString()}`,
                    // eslint-disable-next-line no-template-curly-in-string
                    log_stream_name: '{instance_id}',
                    auto_removal: true,
                  },
                ],
              },
            },
            force_flush_interval: 5,
          },
        }),
      InitCommand.shellCommand('set -ex;/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a stop'),
      // eslint-disable-next-line max-len
      InitCommand.shellCommand('set -ex;/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s'),
      InitCommand.shellCommand('set -ex; sudo echo "vm.max_map_count=262144" >> /etc/sysctl.conf;sudo sysctl -p'),
      InitCommand.shellCommand(`set -ex;mkdir elasticsearch; curl -L ${props.distributionUrl} -o elasticsearch.tar.gz;`
        + 'tar zxf elasticsearch.tar.gz -C elasticsearch --strip-components=1; chown -R ec2-user:ec2-user elasticsearch;', {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }),
      InitCommand.shellCommand('sleep 15'),
    ];

    // Add elasticsearch.yml config
    if (props.singleNodeCluster) {
      const fileContent: any = load(readFileSync(`${configFileDir}/single-node-base-config.yml`, 'utf-8'));

      fileContent['cluster.name'] = `${scope.stackName}-${scope.account}-${scope.region}`;

      opensearchConfig = dump(fileContent).toString();
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd elasticsearch; echo "${opensearchConfig}" > config/elasticsearch.yml`,
        {
          cwd: '/home/ec2-user',
        }));
    } else {
      const baseConfig: any = load(readFileSync(`${configFileDir}/multi-node-base-config.yml`, 'utf-8'));

      baseConfig['cluster.name'] = `${scope.stackName}-${scope.account}-${scope.region}`;

      // use discovery-ec2 to find manager nodes by querying IMDS
      baseConfig['discovery.ec2.tag.Name'] = `${scope.stackName}/seedNodeAsg,${scope.stackName}/managerNodeAsg`;

      // // Change default port to 19200 to allow capture proxy at 9200
      // if (nodeType && (nodeType === 'manager' || nodeType === 'seed-manager')) {
      //   baseConfig['http.port'] = 19200;
      // }

      const commonConfig = dump(baseConfig).toString();
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd elasticsearch; echo "${commonConfig}" > config/elasticsearch.yml`,
        {
          cwd: '/home/ec2-user',
        }));

      if (nodeType != null) {
        const nodeTypeConfig = nodeConfig.get(nodeType);
        const nodeConfigData = dump(nodeTypeConfig).toString();
        cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd elasticsearch; echo "${nodeConfigData}" >> config/elasticsearch.yml`,
          {
            cwd: '/home/ec2-user',
          }));
      }

      if (!props.minDistribution) {
        cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd elasticsearch;sudo -u ec2-user bin/elasticsearch-plugin install discovery-ec2 --batch', {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));
      }

      if (props.enableRemoteStore) {
        // eslint-disable-next-line max-len
        cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd opensearch; echo "node.attr.remote_store.segment.repository: ${scope.stackName}-repo" >> config/opensearch.yml`, {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));

        // eslint-disable-next-line max-len
        cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd opensearch; echo "node.attr.remote_store.repository.${scope.stackName}-repo.type: s3" >> config/opensearch.yml`, {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));

        // eslint-disable-next-line max-len
        cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd opensearch; echo "node.attr.remote_store.repository.${scope.stackName}-repo.settings:\n  bucket : ${scope.stackName}\n  base_path: remote-store\n  region: ${scope.region}" >> config/opensearch.yml`, {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));

        // eslint-disable-next-line max-len
        cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd opensearch; echo "node.attr.remote_store.translog.repository: ${scope.stackName}-repo" >> config/opensearch.yml`, {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));

        // eslint-disable-next-line max-len
        cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd opensearch; echo "node.attr.remote_store.state.repository: ${scope.stackName}-repo" >> config/opensearch.yml`, {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));
      }
    }

    /** Commenting this out for now, with the understanding that the security setting will not work
    if (props.distributionUrl.includes('artifacts.opensearch.org') && !props.minDistribution) {
      cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch;sudo -u ec2-user bin/opensearch-plugin install repository-s3 --batch', {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));
    } else {
      cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch;sudo -u ec2-user bin/opensearch-plugin install '
          + `https://ci.opensearch.org/ci/dbc/distribution-build-opensearch/${props.opensearchVersion}/latest/linux/${props.cpuArch}`
          + `/tar/builds/opensearch/core-plugins/repository-s3-${props.opensearchVersion}.zip --batch`, {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));
    }

    // add config to disable security if required
    if (props.securityDisabled && !props.minDistribution) {
      // eslint-disable-next-line max-len
      cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch; if [ -d "/home/ec2-user/opensearch/plugins/opensearch-security" ]; then echo "plugins.security.disabled: true" >> config/opensearch.yml; fi',
        {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));
    }
   */

    // Check if there are any jvm properties being passed
    // @ts-ignore
    if (props.jvmSysPropsString.toString() !== 'undefined') {
      // @ts-ignore
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex; cd elasticsearch; jvmSysPropsList=$(echo "${props.jvmSysPropsString.toString()}" | tr ',' '\\n');`
        + 'for sysProp in $jvmSysPropsList;do echo "-D$sysProp" >> config/jvm.options;done',
      {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));
    }

    // Check if JVM Heap Memory is set. Default is 1G in the jvm.options file
    // @ts-ignore
    if (props.use50PercentHeap) {
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex; cd elasticsearch;
      totalMem=\`expr $(free -g | awk '/^Mem:/{print $2}') + 1\`;
      heapSizeInGb=\`expr $totalMem / 2\`;
      if [ $heapSizeInGb -lt 32 ];then minHeap="-Xms"$heapSizeInGb"g";maxHeap="-Xmx"$heapSizeInGb"g";else minHeap="-Xms32g";maxHeap="-Xmx32g";fi
      sed -i -e "s/^-Xms[0-9a-z]*$/$minHeap/g" config/jvm.options;
      sed -i -e "s/^-Xmx[0-9a-z]*$/$maxHeap/g" config/jvm.options;`, {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));
    }

    // @ts-ignore
    if (props.additionalConfig.toString() !== 'undefined') {
      // @ts-ignore
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex; cd elasticsearch; echo "${props.additionalConfig}">>config/elasticsearch.yml`,
        {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));
    }

    // Final run command for elasticsearch
    cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd elasticsearch; sudo -u ec2-user nohup ./bin/elasticsearch >> install.log 2>&1 &',
      {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));

    // Download and unpack capture proxy as well as add capture proxy startup script. Currently, places capture proxy required files
    // on all nodes but only Coordinator nodes need
    if (props.captureProxyEnabled) {
      // eslint-disable-next-line max-len
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex; curl -L0 ${props.captureProxyTarUrl} --output CaptureProxyX64.tar.gz; tar -xvf CaptureProxyX64.tar.gz;`,
        {
          cwd: '/home/ec2-user/capture-proxy',
          ignoreErrors: false,
        }));
      const startProxyFile = InitFile.fromFileInline('/home/ec2-user/capture-proxy/startCaptureProxy.sh', './startCaptureProxy.sh', {
        mode: '000744',
      });
      cfnInitConfig.push(startProxyFile);
    }

    // If OpenSearch-Dashboards URL is present
    if (props.dashboardsUrl !== 'undefined') {
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex;mkdir opensearch-dashboards; curl -L ${props.dashboardsUrl} -o opensearch-dashboards.tar.gz;`
        + 'tar zxf opensearch-dashboards.tar.gz -C opensearch-dashboards --strip-components=1; chown -R ec2-user:ec2-user opensearch-dashboards;', {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));

      cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch-dashboards;echo "server.host: 0.0.0.0" >> config/opensearch_dashboards.yml',
        {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));

      if (props.securityDisabled && !props.minDistribution) {
        cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch-dashboards;'
          + './bin/opensearch-dashboards-plugin remove securityDashboards --allow-root;'
          + 'sed -i /^opensearch_security/d config/opensearch_dashboards.yml;'
          + 'sed -i \'s/https/http/\' config/opensearch_dashboards.yml',
        {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));
      }

      // @ts-ignore
      if (props.additionalOsdConfig.toString() !== 'undefined') {
        // @ts-ignore
        cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd opensearch-dashboards; echo "${props.additionalOsdConfig}">>config/opensearch_dashboards.yml`,
          {
            cwd: '/home/ec2-user',
            ignoreErrors: false,
          }));
      }

      // Startinng OpenSearch-Dashboards
      cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch-dashboards;'
        + 'sudo -u ec2-user nohup ./bin/opensearch-dashboards > dashboard_install.log 2>&1 &', {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));
    }

    return cfnInitConfig;
  }
}
