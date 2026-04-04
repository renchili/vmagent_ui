import YAML from 'yaml';

export function buildVmagentFlagArgs(profile, configPath) {
  const args = [`-promscrape.config=${configPath}`];
  const { cluster, remoteWrite } = profile;

  if (cluster.enabled) {
    args.push(`-promscrape.cluster.membersCount=${cluster.membersCount}`);
    args.push(`-promscrape.cluster.memberNum=${cluster.memberNum}`);
    args.push(`-promscrape.cluster.replicationFactor=${cluster.replicationFactor}`);
  }

  if (remoteWrite.shardByURL) {
    args.push('-remoteWrite.shardByURL');
  }

  if (remoteWrite.tmpDataPath) {
    args.push(`-remoteWrite.tmpDataPath=${remoteWrite.tmpDataPath}`);
  }

  return args;
}

export function renderDeploymentArtifacts(profile) {
  return {
    docker: renderDocker(profile),
    compose: renderCompose(profile),
    kubernetes: renderKubernetes(profile),
    systemd: renderSystemd(profile),
  };
}

function renderDocker(profile) {
  const docker = profile.deployment.docker;
  const args = [...buildVmagentFlagArgs(profile, docker.configMountPath), ...(docker.extraArgs || [])];
  const command = [
    'docker run -d',
    `  --name ${docker.containerName}`,
    `  -v ./config.yml:${docker.configMountPath}:ro`,
    `  -v vmagent-data:${docker.dataMountPath}`,
    `  ${docker.image}`,
    ...args.map((arg) => `  ${arg}`),
  ].join(' \\\n');

  return { type: 'docker', command, args };
}

function renderCompose(profile) {
  const docker = profile.deployment.docker;
  const args = [...buildVmagentFlagArgs(profile, docker.configMountPath), ...(docker.extraArgs || [])];
  const service = {
    image: docker.image,
    container_name: docker.containerName,
    restart: 'unless-stopped',
    command: args,
    volumes: [
      `./config.yml:${docker.configMountPath}:ro`,
      `vmagent-data:${docker.dataMountPath}`,
    ],
  };

  const compose = {
    services: {
      [docker.containerName || 'vmagent']: service,
    },
    volumes: {
      'vmagent-data': {},
    },
  };

  const yaml = YAML.stringify(compose, { lineWidth: 0 });
  return { type: 'compose', yaml, compose, args, serviceName: docker.containerName || 'vmagent' };
}

function renderKubernetes(profile) {
  const k8s = profile.deployment.kubernetes;
  const args = [...buildVmagentFlagArgs(profile, k8s.configMountPath), ...(k8s.extraArgs || [])];
  const manifest = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: k8s.name, namespace: k8s.namespace },
    spec: {
      replicas: k8s.replicas,
      selector: { matchLabels: { app: k8s.name } },
      template: {
        metadata: { labels: { app: k8s.name } },
        spec: {
          containers: [
            {
              name: 'vmagent',
              image: 'victoriametrics/vmagent:latest',
              args,
              volumeMounts: [
                { name: 'config', mountPath: k8s.configMountPath, subPath: 'config.yml' },
                { name: 'data', mountPath: k8s.dataMountPath },
              ],
            },
          ],
          volumes: [
            { name: 'config', configMap: { name: `${k8s.name}-config` } },
            { name: 'data', emptyDir: {} },
          ],
        },
      },
    },
  };
  return { type: 'kubernetes', manifest: YAML.stringify(manifest), args };
}

function renderSystemd(profile) {
  const systemd = profile.deployment.systemd;
  const args = [...buildVmagentFlagArgs(profile, systemd.configPath), ...(systemd.extraArgs || [])];
  const execStart = `/usr/local/bin/vmagent ${args.join(' ')}`;
  const unit = [
    '[Unit]',
    'Description=vmagent',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${execStart}`,
    'Restart=always',
    `StateDirectory=${systemd.serviceName}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n');

  return {
    type: 'systemd',
    unit,
    args,
    execStart,
    serviceName: systemd.serviceName,
    paths: {
      unitFile: `/etc/systemd/system/${systemd.serviceName}.service`,
      configPath: systemd.configPath,
      dataPath: systemd.dataPath,
    },
  };
}
